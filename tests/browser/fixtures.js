export async function docScreenshot(page, options) {
  if (process.env.UPDATE_DOC_SCREENSHOTS === '1') await page.screenshot(options);
}

export async function clipboardText(page) {
  return (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n');
}
