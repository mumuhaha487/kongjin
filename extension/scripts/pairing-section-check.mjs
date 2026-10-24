import assert from "node:assert/strict";

// Check rendered content and effective opacity, not only DOM presence: a shared
// layout source can remain in the DOM while Motion deliberately hides it.
export async function assertPairingSection(page, { paired, devices = 0 }) {
  const selector = paired
    ? "#settings-pairing .device-list"
    : "#settings-pairing .pair-summary-card";
  await page.locator(selector).scrollIntoViewIfNeeded();
  await page.waitForFunction((selector) => {
    const el = document.querySelector(selector);
    if (!el) return false;
    let opacity = 1;
    for (let parent = el; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.visibility !== "visible" || style.display === "none")
        return false;
      opacity *= Number(style.opacity);
    }
    return opacity >= 0.99;
  }, selector);
  const content = page.locator(selector);
  const bounds = await content.boundingBox();
  assert.ok(bounds && bounds.width > 100 && bounds.height > 40);
  if (paired) {
    assert.equal(await content.locator(".device-row").count(), devices);
    assert.equal(
      await page.locator("#settings-pairing .status-line").count(),
      1,
    );
    assert.ok((await content.innerText()).trim().length > 0);
  } else {
    assert.ok((await content.innerText()).includes("实时配对"));
    for (const name of ["创建配对组", "加入已有配对组"])
      assert.equal(
        await content.getByRole("button", { name, exact: true }).count(),
        1,
      );
  }
  return {
    paired,
    devices,
    bounds,
    rendered: true,
    effectiveOpacityAtLeast: 0.99,
  };
}
