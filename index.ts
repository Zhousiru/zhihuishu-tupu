import OpenAI from 'openai'
import prompts from 'prompts'
import puppeteer from 'puppeteer'

interface TaskData {
  title: string
  percent: number
}

interface QaData {
  stem: string
  answers: number[]
}

import dotenv from 'dotenv'
dotenv.config() // Load environment variables from .env file

const openai = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.KEY,
})

function delay(time: number) {
  return new Promise(function (resolve) {
    setTimeout(resolve, time)
  })
}

;(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
  })

  const page = (await browser.pages())[0]
  await page.goto('https://onlineweb.zhihuishu.com/')

  for (;;) {
    const ready = await prompts({
      type: 'confirm',
      name: 'value',
      message:
        '已经登录，并且点进需要完成的课程了吗？\n  此时地址栏应为：https://ai.zhihuishu.com/AIstudent/**/**',
      initial: true,
    })
    if ('value' in ready) {
      if (ready['value']) break
    } else {
      await browser.close()
      return
    }
  }

  const tasks = await Promise.all(
    (
      await page.$$('.card-item')
    ).map(async (v) => {
      const titleEl = await v.$('.point-title')
      const title = (await page.evaluate(
        (el) => el!.textContent,
        titleEl
      ))!.trim()
      const percentEl = await v.$('.card-percent')
      const percent = Number(
        (await page.evaluate((el) => el!.textContent, percentEl))!
          .trim()
          .slice(0, -1)
      )
      return {
        title,
        percent,
      } as TaskData
    })
  )

  const { which } = await prompts({
    type: 'text',
    name: 'which',
    message: '从哪个开始做？\n  （输入标题开头，留空则从第一个开始）',
  })

  const whichIndex = tasks.findIndex((v) => v.title.startsWith(which))
  tasks.splice(0, whichIndex)

  for (const [index, task] of tasks.entries()) {
    if (task.percent === 100) continue

    await delay(500)
    const qa: QaData[] = []
    for (;;) {
      await delay(2000)
      console.log(`即将开始做：${task.title}`)
      let targetCardEl: any

      for (const el of await page.$$('.card-item')) {
        const titleEl = await el.$('.point-title')
        const title = (await page.evaluate(
          (el) => el!.textContent,
          titleEl
        ))!.trim()
        if (title === task.title) {
          targetCardEl = el
          break
        }
      }

      await targetCardEl!.click()
      await delay(1000)

      if (await page.$('.empty-text')) {
        page.goBack()
        break
      }

      ;(await page.$('.practice-handle'))!.click()

      await page.waitForSelector('.questions-list')
      const qEl = await (await page.$('.questions-list'))!.$$('.questions-item')
      const qCount = qEl.length

      console.log(`- 有 ${qCount} 道题目`)
      let isWrong = false

      for (let qIndex = 0; qIndex < qCount; qIndex++) {
        console.log(`- 正在做第 ${qIndex + 1} 道`)
        // qEl[qIndex].click()

        await delay(1000)

        const qTypeEl = await page.$('.question-type')
        const qType = (await page.evaluate(
          (el) => el!.textContent,
          qTypeEl
        ))!.trim()

        const qStemEl = await page.$('.stem')
        const qStem = (await page.evaluate(
          (el) => el!.textContent,
          qStemEl
        ))!.trim()

        const qDetailEl = await page.$('.question-detail-item.ques-detail')
        const qDetails = await Promise.all(
          (
            await qDetailEl!.$$('label')
          ).map(async (v) =>
            (await page.evaluate((el) => el!.textContent, v))!.trim()
          )
        )

        const qaIndex = qa.findIndex((v) => v.stem === qStem)
        if (qaIndex !== -1) {
          console.log('  - 使用缓存答案')
          const choiceNum = qa[qaIndex].answers
          for (const c of choiceNum) {
            ;(await qDetailEl!.$(`label:nth-of-type(${c})`))?.click()
            await delay(500)
          }
          ;(await page.$('.next-btns-box'))?.click()
          await delay(500)
          ;(await page.$('.next-btns-box'))?.click()
          continue
        }

        if (!['【单选题】', '【多选题】'].includes(qType)) {
          console.log(`  - 题目类型：${qType}，不支持，自己做`)

          continue
        }

        console.log(`  - 题目类型：${qType}`)
        console.log(`  - 题干：${qStem}`)
        console.log(`  - 选项：\n    - ${qDetails.join('\n    - ')}`)

        const resp: any = await (
          await fetch('http://cx.icodef.com/wyn-nb?v=4', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
              question: qStem,
            }).toString(),
          })
        ).json()

        let searchResult = ''

        if (resp.code !== 1) {
          searchResult = '无结果'
        } else {
          searchResult = resp.data
        }

        console.log(`  - 题库答案：${searchResult}`)

        const aiResp = await openai.chat.completions.create({
          model: 'gpt-4o',
          messages: [
            {
              role: 'system',
              content:
                '你是一个解题助手，用户将给你题目类型、题干、选项、以及参考答案，你需要根据参考答案匹配对应的选项。如果参考答案为“无结果”，请简要分析题目后给出正确的答案，注意需要简要分析。答案使用 ## 包裹，例如：##A##、##CD##',
            },
            {
              role: 'user',
              content:
                '【单选题】CPU地址线数量与下列哪项指标密切相关（  ）。\n\nA.内存容量\n\nB.存储数据位\n\nC.运算速度\n\nD.运算精确度\n\n参考答案：内存容量',
            },
            {
              role: 'assistant',
              content: '##A##',
            },
            {
              role: 'user',
              content: `${qType}${qStem}\n\n${qDetails.join(
                '\n\n'
              )}\n\n参考答案：${searchResult}`,
            },
          ],
        })

        const aiMsg = aiResp.choices[0].message.content
        if (!aiMsg) {
          console.error('  - AI 响应错误')
          continue
        }
        const matches = aiMsg.match(/##(.*?)##/)
        if (!matches) {
          console.error('  - AI 响应错误')
          continue
        }

        const choice = matches[1]
        const choiceNum = choice.split('').map((v) => v.charCodeAt(0) - 64)

        console.log(`  - 选择：${choice}`)

        for (const c of choiceNum) {
          ;(await qDetailEl!.$(`label:nth-of-type(${c})`))?.click()
          await delay(500)
        }

        ;(await page.$('.next-btns-box'))?.click()

        await delay(500)

        await page.waitForSelector('.answer-tips')
        const resultEl = await page.$('.answer-tips')!
        const result = (await page.evaluate(
          (el) => el!.textContent,
          resultEl
        ))!.trim()

        if (result.includes('回答正确')) {
          qa.push({ stem: qStem, answers: choiceNum })
        } else {
          isWrong = true
          const rightEl = await page.$('.question-answer-right')!
          const right = (await page.evaluate(
            (el) => el!.textContent,
            rightEl
          ))!.replace(/[^A-Za-z]/g, '')
          qa.push({
            stem: qStem,
            answers: right.split('').map((v: string) => v.charCodeAt(0) - 64),
          })
        }

        ;(await page.$('.next-btns-box'))?.click()
        await delay(500)
      }

      await delay(500)
      page.goBack()

      if (!isWrong) {
        break
      }
    }
  }
})()
