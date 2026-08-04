import { expect, test, type Page } from "@playwright/test"

async function expectNoPageErrors(page: Page, run: () => Promise<void>) {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await run()
  expect(errors).toEqual([])
}

test("completes the Stroop task", async ({ page }) => {
  await expectNoPageErrors(page, async () => {
    await page.goto("/experiments/stroop/index.html")
    await page.getByRole("button", { name: "开始实验" }).click()

    for (let trial = 0; trial < 16; trial += 1) {
      await expect(page.locator("#stimulus")).toHaveClass(/word/)
      await page.locator(".answer").first().click()
      if (trial < 15) await expect(page.locator("#stimulus")).toHaveClass(/fixation/)
    }

    await expect(page.locator("#results")).toHaveClass(/active/)
    await expect(page.locator("#accuracy")).not.toHaveText("--")
  })
})

test("completes the reaction-time task", async ({ page }) => {
  await expectNoPageErrors(page, async () => {
    await page.goto("/experiments/reaction-time/index.html")
    await page.getByRole("button", { name: "开始实验" }).click()

    for (let trial = 0; trial < 5; trial += 1) {
      await expect(page.locator("#dot")).toHaveClass(/visible/)
      await page.keyboard.press("Space")
      if (trial < 4) await expect(page.locator("#dot")).not.toHaveClass(/visible/)
    }

    await expect(page.locator("#results")).toHaveClass(/active/)
    await expect(page.locator("#mean")).not.toHaveText("--")
  })
})

test("completes the 2-back task", async ({ page }) => {
  await expectNoPageErrors(page, async () => {
    await page.goto("/experiments/n-back/index.html")
    await page.getByRole("button", { name: "开始实验" }).click()

    for (let trial = 3; trial <= 16; trial += 1) {
      await expect(page.locator("#progress")).toHaveText(`${trial} / 16`)
      await expect(page.locator("#status")).toHaveText("请作答")
      await page.keyboard.press("n")
    }

    await expect(page.locator("#results")).toHaveClass(/active/)
    await expect(page.locator("#accuracy")).not.toHaveText("--")
  })
})

test("exchanges messages through the Agent bridge contract", async ({ page }) => {
  await expectNoPageErrors(page, async () => {
    await page.goto("/experiments/agent-chat/index.html")
    await page.evaluate(() => {
      const target = window as Window & { agentRequests?: Array<Record<string, unknown>> }
      target.agentRequests = []
      window.addEventListener("message", (event) => {
        if (event.data?.type === "haolab.agent.send") target.agentRequests?.push(event.data)
      })
      window.postMessage({ type: "haolab.agent.ready", agent: "build", model: "Test Provider / Test Model" }, "*")
    })

    await expect(page.locator("#connectionLabel")).toHaveText("已连接 OpenCode")
    await page.getByLabel("消息").fill("你好")
    await page.getByRole("button", { name: "发送" }).click()
    await expect
      .poll(() => page.evaluate(() => (window as Window & { agentRequests?: Array<Record<string, unknown>> }).agentRequests?.[0]?.text))
      .toBe("你好")
    const request = await page.evaluate(() => (window as Window & { agentRequests?: Array<Record<string, unknown>> }).agentRequests?.[0])
    await page.evaluate((requestID) => {
      window.postMessage({ type: "haolab.agent.response", requestId: requestID, text: "你好，我已经通过容器返回。" }, "*")
    }, request?.requestId)

    await expect(page.locator(".message.assistant .message-text")).toHaveText("你好，我已经通过容器返回。")
  })
})
