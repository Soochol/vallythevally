import type { CDPSession, Page } from "@playwright/test";
import { cell, expect, test } from "./harness";

test.use({ viewport: { width: 1440, height: 900 } });

const AWAY = { x: 700, y: 450 };

async function open(page: Page) {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
}

function descriptionReader(cdp: CDPSession) {
  return async (role: string, name: string): Promise<string> => {
    const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
    const { nodes } = await cdp.send("Accessibility.queryAXTree", { nodeId: root.nodeId, role, accessibleName: name });
    expect(nodes, `${role} "${name}"`).toHaveLength(1);
    return String(nodes[0]!.description?.value ?? "");
  };
}

const indicatorsButton = (page: Page) => page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "지표", exact: true });

test("마우스를 올린 단추는 툴팁이 뜨기 전 지연 동안에도 접근 가능한 설명을 유지한다", async ({ page }) => {
  await page.clock.install();
  await open(page);
  const description = descriptionReader(await page.context().newCDPSession(page));
  const indicators = indicatorsButton(page);
  const tip = page.getByRole("tooltip");
  expect(await description("button", "지표")).toBe("지표 (I)");

  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await indicators.hover();
  await expect(indicators).not.toHaveAttribute("title");
  await expect(tip).toHaveCount(0);
  expect(await description("button", "지표")).toBe("지표 (I)");

  await page.clock.runFor(400);
  await expect(tip).toHaveText("지표I");
  expect(await description("button", "지표")).toBe("지표 I");
});

test("마우스를 올린 채 키를 눌러 툴팁을 닫아도 단추의 접근 가능한 설명은 포인터가 떠날 때까지 남는다", async ({ page }) => {
  await open(page);
  const description = descriptionReader(await page.context().newCDPSession(page));
  const indicators = indicatorsButton(page);
  const tip = page.getByRole("tooltip");

  await indicators.hover();
  await expect(tip).toHaveText("지표I");
  await page.keyboard.press("Shift");
  await expect(tip).toHaveCount(0);
  await expect(indicators).not.toHaveAttribute("title");
  expect(await description("button", "지표")).toBe("지표 (I)");

  await page.mouse.move(AWAY.x, AWAY.y);
  await expect(indicators).toHaveAttribute("title", "지표 (I)");
  expect(await description("button", "지표")).toBe("지표 (I)");
});

test("글자와 같은 title은 마우스를 올린 동안에도 접근 가능한 설명으로 덧붙지 않는다", async ({ page }) => {
  await open(page);
  const description = descriptionReader(await page.context().newCDPSession(page));
  const quarter = page.getByRole("group", { name: "봉 주기" }).getByRole("button", { name: "분기", exact: true });
  const tip = page.getByRole("tooltip");
  await expect(quarter).toHaveAttribute("title", "분기");
  expect(await description("button", "분기")).toBe("");

  await quarter.hover();
  await expect(quarter).not.toHaveAttribute("title");
  expect(await description("button", "분기")).toBe("");
  await expect(tip).toHaveText("분기");
  await page.keyboard.press("Shift");
  await expect(tip).toHaveCount(0);
  expect(await description("button", "분기")).toBe("");
});

test("요소가 가진 설명과 글자와 공백만 다른 title은 마우스를 올린 동안에도 올리기 전 설명 그대로다", async ({ page }) => {
  await open(page);
  const description = descriptionReader(await page.context().newCDPSession(page));
  await page.evaluate(() => {
    const own = document.createElement("button");
    own.title = "툴팁 안내";
    own.setAttribute("aria-label", "설명 가진 단추");
    own.setAttribute("aria-description", "원래 설명");
    const broken = document.createElement("button");
    broken.title = "가 나";
    broken.setAttribute("aria-label", "줄 바뀐 단추");
    broken.append("가", document.createElement("br"), "나");
    for (const [i, probe] of [own, broken].entries()) {
      probe.type = "button";
      probe.style.cssText = `position:fixed;left:${40 + i * 100}px;top:40px;width:80px;height:40px;z-index:2147483647`;
      document.body.append(probe);
    }
  });
  const cases = [{ name: "설명 가진 단추", text: "원래 설명" }, { name: "줄 바뀐 단추", text: "가 나" }];
  for (const { name, text } of cases) {
    const probe = page.getByRole("button", { name, exact: true });
    expect(await description("button", name)).toBe(text);
    await probe.hover();
    await expect(probe).not.toHaveAttribute("title");
    expect(await description("button", name)).toBe(text);
    await page.mouse.move(AWAY.x, AWAY.y);
    await expect(probe).toHaveAttribute("title");
    expect(await description("button", name)).toBe(text);
  }
});

test("마우스를 올린 동안 화면이 쓴 aria-description은 title이 바뀌어도, 포인터가 떠난 뒤에도 그대로다", async ({ page }) => {
  await open(page);
  const description = descriptionReader(await page.context().newCDPSession(page));
  await page.evaluate(() => {
    const probe = document.createElement("button");
    probe.type = "button";
    probe.title = "처음 안내";
    probe.setAttribute("aria-label", "툴팁 시험 단추");
    probe.style.cssText = "position:fixed;left:40px;top:40px;width:80px;height:40px;z-index:2147483647";
    document.body.append(probe);
  });
  const probe = page.getByRole("button", { name: "툴팁 시험 단추", exact: true });

  await probe.hover();
  await expect(probe).not.toHaveAttribute("title");
  await probe.evaluate((node) => node.setAttribute("aria-description", "화면 설명"));
  await probe.evaluate((node) => node.setAttribute("title", "바뀐 안내"));
  await expect(page.getByRole("tooltip")).toHaveText("바뀐 안내");
  await page.keyboard.press("Shift");
  expect(await description("button", "툴팁 시험 단추")).toBe("화면 설명");
  await page.mouse.move(AWAY.x, AWAY.y);
  await expect(probe).toHaveAttribute("title", "바뀐 안내");
  await expect(probe).toHaveAttribute("aria-description", "화면 설명");
  expect(await description("button", "툴팁 시험 단추")).toBe("화면 설명");
});

test("마우스를 올린 동안 화면이 title을 바꾸거나 지우면 툴팁과 포인터가 떠난 뒤의 title과 접근 가능한 설명이 그 값을 따른다", async ({ page }) => {
  await open(page);
  const description = descriptionReader(await page.context().newCDPSession(page));
  await page.evaluate(() => {
    const probe = document.createElement("button");
    probe.type = "button";
    probe.title = "처음 안내";
    probe.setAttribute("aria-label", "툴팁 시험 단추");
    probe.style.cssText = "position:fixed;left:40px;top:40px;width:80px;height:40px;z-index:2147483647";
    document.body.append(probe);
  });
  const probe = page.getByRole("button", { name: "툴팁 시험 단추", exact: true });
  const tip = page.getByRole("tooltip");

  await probe.hover();
  await expect(tip).toHaveText("처음 안내");
  await probe.evaluate((node) => node.setAttribute("title", "바뀐 안내"));
  await expect(tip).toHaveText("바뀐 안내");
  await page.keyboard.press("Shift");
  await expect(tip).toHaveCount(0);
  expect(await description("button", "툴팁 시험 단추")).toBe("바뀐 안내");
  await page.mouse.move(AWAY.x, AWAY.y);
  await expect(probe).toHaveAttribute("title", "바뀐 안내");

  await probe.hover();
  await expect(tip).toHaveText("바뀐 안내");
  await probe.evaluate((node) => node.removeAttribute("title"));
  await expect(tip).toHaveCount(0);
  expect(await description("button", "툴팁 시험 단추")).toBe("");
  await page.mouse.move(AWAY.x, AWAY.y);
  await expect(probe).not.toHaveAttribute("title");
  await probe.hover();
  await expect(tip).toHaveCount(0);
});
