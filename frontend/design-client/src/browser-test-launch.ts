import { existsSync } from 'node:fs'
import { chromium } from 'playwright'

export function launchLayoutTestBrowser() {
  const executablePath = process.env.CHROME_PATH
  const browser = executablePath ? { executablePath } :
    existsSync(chromium.executablePath()) ? {} : { channel: 'chrome' }
  return chromium.launch({
    ...browser,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  })
}
