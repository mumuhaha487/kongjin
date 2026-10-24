import type { AppData, Bookmark } from "../lib/model";
// Standalone, no runtime imports and no network access. Only stored data URLs render.
(() => {
  if (
    document.querySelector("kongjing-bar") ||
    !/^https?:$/.test(location.protocol) ||
    /(^|\.)(chromewebstore\.google\.com|chrome\.google\.com|microsoftedge\.microsoft\.com)$/.test(
      location.hostname,
    )
  )
    return;
  let existingId: string | undefined;
  let collected: { group: string; until: number } | undefined;
  let collectedTimer = 0;
  const host = document.createElement("kongjing-bar");
  host.style.cssText =
    "all:initial;position:fixed;inset:0;z-index:2147483646;pointer-events:none";
  const shadow = host.attachShadow({ mode: "closed" });
  document.documentElement.append(host);
  let data: AppData | undefined,
    selected = "",
    opened = false,
    opening = 0,
    closing = 0,
    fading = 0,
    menu: HTMLElement | undefined;
  const style = document.createElement("style");
  style.textContent = String.raw`:host{--bg:#F3F6FA;--surface:rgba(248,250,253,.80);--surface-hover:rgba(127,160,220,.16);--border:rgba(255,255,255,.6);--border-strong:rgba(30,60,120,.18);--text:#121826;--text2:rgba(18,24,38,.60);--text3:rgba(18,24,38,.40);--accent:#2F6CEB;--ease-out:cubic-bezier(.22,1,.36,1);font:12px system-ui,"PingFang SC","Microsoft YaHei UI",sans-serif;color:var(--text)}*{box-sizing:border-box}button{font:inherit;color:inherit;border:0;background:none;cursor:pointer;padding:0}button:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}button:disabled{opacity:.4}.handle{position:fixed;top:4px;left:50%;width:48px;height:4px;margin-left:-24px;border-radius:2px;background:rgba(70,100,160,.32);box-shadow:0 0 0 1px rgba(255,255,255,.45);opacity:0;transition:opacity 200ms;pointer-events:auto}.hot{position:fixed;top:0;left:50%;width:320px;height:8px;margin-left:-160px;pointer-events:auto}.dock{position:fixed;left:50%;top:8px;translate:-50% 0;display:flex;gap:0;align-items:center;height:48px;padding:6px;border-radius:16px;background:var(--surface);border:1px solid var(--border);backdrop-filter:blur(20px) saturate(160%);box-shadow:0 16px 40px -16px rgba(10,20,50,.35);transform-origin:top center;opacity:0;pointer-events:none;max-width:calc(100vw - 16px)}.dock.open{opacity:1;pointer-events:auto}.dock button{height:36px;flex:none}.group{display:flex;align-items:center;gap:8px;padding:0 10px;max-width:96px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:500;border-radius:10px}.group>span{overflow:hidden;text-overflow:ellipsis}.group>svg{flex:none}.divider{width:1px;height:20px;background:var(--border-strong);margin:0 6px;flex:none}.bookmark,.collect,.more{position:relative;width:36px;border-radius:10px;display:grid;place-items:center}.bookmark:hover,.collect:hover,.more:hover,.group:hover{background:var(--surface-hover)}.bookmark img{width:20px;height:20px;object-fit:contain}.letter{font-size:13px;width:24px;height:24px;border-radius:8px;display:grid;place-items:center;background:hsl(var(--h) 40% 52% / .10);color:hsl(var(--h) 42% 38%)}.tip{position:absolute;left:50%;top:42px;translate:-50% 0;white-space:nowrap;font-size:12px;padding:6px 10px;border-radius:8px;background:var(--surface);border:1px solid var(--border);backdrop-filter:blur(20px);opacity:0;pointer-events:none;transition:opacity 100ms}.bookmark:hover .tip{opacity:1;transition:opacity 120ms 300ms}.menu{position:fixed;top:64px;left:50%;translate:-50% 0;min-width:200px;padding:6px;border-radius:12px;background:var(--surface);border:1px solid var(--border);backdrop-filter:blur(20px) saturate(160%);box-shadow:0 16px 40px -16px rgba(10,20,50,.35);pointer-events:auto}.menu button{height:36px;display:flex;align-items:center;gap:8px;padding:0 10px;width:100%;border-radius:8px;white-space:nowrap;text-align:left}.menu button:hover{background:var(--surface-hover)}.menu.grid{display:grid;grid-template-columns:repeat(6,36px);gap:6px;min-width:0}.menu.grid .bookmark{width:36px;padding:0;justify-content:center}.left.handle,.right.handle{top:50%;margin-top:-24px;margin-left:0;width:4px;height:48px;left:4px}.right.handle{left:auto;right:4px}.left.hot,.right.hot{top:50%;margin-top:-160px;margin-left:0;left:0;width:8px;height:320px}.right.hot{left:auto;right:0}.left.dock,.right.dock{top:50%;left:8px;translate:0 -50%;flex-direction:column;width:48px;height:auto;max-height:calc(100vh - 16px);transform-origin:left center}.right.dock{left:auto;right:8px;transform-origin:right center}.left.dock .group,.right.dock .group{width:36px;writing-mode:vertical-rl;flex-direction:column;padding:8px 0;max-height:96px;height:auto}.left.dock .divider,.right.dock .divider{width:20px;height:1px;margin:6px 0}.left.menu{left:64px;top:50%;translate:0 -50%}.right.menu{left:auto;right:64px;top:50%;translate:0 -50%}.dark{--bg:#070B16;--surface:rgba(12,18,34,.80);--border:rgba(170,200,255,.14);--border-strong:rgba(170,200,255,.20);--text:#EEF2FA;--text2:rgba(238,242,250,.62);--text3:rgba(238,242,250,.38);--accent:#7DB0FF}.dark .letter{background:hsl(var(--h) 42% 56% / .14);color:hsl(var(--h) 58% 78%)}@media print{.handle,.hot,.dock,.menu{display:none!important}}`;
  shadow.append(style);
  style.textContent +=
    '.dark img[data-tone="dark"],:host(:not(.dark)) img[data-tone="light"]{filter:invert(1) hue-rotate(180deg)}';
  const handle = document.createElement("div"),
    hot = document.createElement("div"),
    dock = document.createElement("nav");
  handle.className = "handle";
  hot.className = "hot";
  dock.className = "dock";
  dock.setAttribute("aria-label", "空境栏");
  shadow.append(handle, hot, dock);
  const icon = (checked = false) =>
    checked
      ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16Z"/><path d="m8 9 3 3 5-5"/></svg>'
      : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16Z"/><path d="M12 7v6m-3-3h6"/></svg>';
  function send(message: unknown) {
    return chrome.runtime.sendMessage(message);
  }
  function button(label: string, click: (e: MouseEvent) => void, cls = "") {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.setAttribute("aria-label", label);
    b.className = cls;
    b.addEventListener("click", click);
    return b;
  }
  function clearMenu() {
    menu?.remove();
    menu = undefined;
  }
  function openMenu(
    items: { label: string; click: () => void }[],
    grid = false,
  ) {
    clearMenu();
    menu = document.createElement("div");
    menu.className =
      "menu " +
      (data?.settings.barPosition || "top") +
      (grid ? " grid" : "") +
      (dock.classList.contains("dark") ? " dark" : "");
    menu.setAttribute("role", "menu");
    for (const i of items) {
      const b = button(i.label, () => {
        i.click();
        clearMenu();
      });
      b.setAttribute("role", "menuitem");
      menu.append(b);
    }
    shadow.append(menu);
    menu.querySelector("button")?.focus();
  }
  function bookmarkButton(b: Bookmark) {
    const btn = button(
      b.title,
      (e) => {
        if (e.ctrlKey || e.metaKey) void send({ type: "kj:open", url: b.url });
        else location.href = b.url;
      },
      "bookmark",
    );
    btn.addEventListener("auxclick", (e) => {
      if (e.button === 1) {
        e.preventDefault();
        void send({ type: "kj:open", url: b.url });
      }
    });
    btn.textContent = "";
    if (b.icon.dataUrl) {
      const img = document.createElement("img");
      img.src = b.icon.dataUrl;
      img.alt = "";
      if (b.icon.tone) img.dataset.tone = b.icon.tone;
      btn.append(img);
    } else {
      const letter = document.createElement("span");
      letter.className = "letter";
      let h = 0;
      for (const c of new URL(b.url).hostname)
        h = ((h << 5) - h + c.charCodeAt(0)) | 0;
      letter.style.setProperty("--h", String((h >>> 0) % 360));
      letter.textContent = Array.from(b.title)[0] || "?";
      btn.append(letter);
    }
    const tip = document.createElement("span");
    tip.className = "tip";
    tip.textContent = b.title;
    btn.append(tip);
    return btn;
  }
  function render() {
    if (!data) return;
    const s = data.settings;
    const hidden =
      !s.barEnabled ||
      s.hiddenSites.includes(location.hostname) ||
      innerWidth < 480 ||
      !!document.fullscreenElement;
    host.style.display = hidden ? "none" : "block";
    const dark =
      s.theme === "dark" ||
      (s.theme === "system" &&
        matchMedia("(prefers-color-scheme: dark)").matches);
    for (const e of [handle, hot, dock])
      e.className =
        e === handle
          ? "handle " + s.barPosition
          : e === hot
            ? "hot " + s.barPosition
            : "dock " + s.barPosition + (opened ? " open" : "");
    host.classList.toggle("dark", dark);
    dock.classList.toggle("dark", dark);
    const themes = {
      sky: ["#7DB0FF", "#2F6CEB"],
      mist: ["#5EDCCB", "#0F9F8F"],
      dusk: ["#FFB08A", "#E3672E"],
      nebula: ["#B6A4FF", "#6E56F0"],
      sakura: ["#FF9EC0", "#DE4A7E"],
    };
    host.style.setProperty("--accent", themes[s.accent][dark ? 0 : 1]);
    selected = data.groups.some((g) => g.id === selected)
      ? selected
      : data.groups[0]?.id;
    const group = data.groups.find((g) => g.id === selected);
    dock.replaceChildren();
    const groupBtn = button(
      group?.name || "常用",
      () =>
        openMenu(
          data!.groups.map((g) => ({
            label: g.name,
            click: () => {
              selected = g.id;
              render();
            },
          })),
        ),
      "group",
    );
    const groupLabel = document.createElement("span");
    groupLabel.textContent = group?.name || "常用";
    groupBtn.replaceChildren(groupLabel);
    groupBtn.insertAdjacentHTML(
      "beforeend",
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
    );
    dock.append(groupBtn);
    const divider = () => {
      const el = document.createElement("span");
      el.className = "divider";
      return el;
    };
    dock.append(divider());
    const bookmarks = data.bookmarks
      .filter((b) => b.groupId === selected)
      .sort((a, b) => a.order - b.order);
    const max = Math.min(
      16,
      s.barPosition === "top"
        ? Math.max(1, Math.floor((innerWidth - 220) / 36))
        : Math.max(1, Math.floor((innerHeight - 220) / 36)),
    );
    for (const b of bookmarks.slice(0, max)) dock.append(bookmarkButton(b));
    if (bookmarks.length > max) {
      const more = button(
        "···",
        () => {
          openMenu([], true);
          for (const b of bookmarks.slice(max)) menu!.append(bookmarkButton(b));
        },
        "more",
      );
      dock.append(more);
    }
    dock.append(divider());
    const existing = data.bookmarks.find((b) => b.id === existingId);
    const collect = button(
      "收藏本页",
      () => {
        if (existing) {
          openMenu([
            {
              label:
                "从「" +
                (data!.groups.find((g) => g.id === existing.groupId)?.name ||
                  "常用") +
                "」移除",
              click: () => {
                void send({ type: "kj:remove-bookmark", id: existing.id });
              },
            },
          ]);
        } else
          void send({
            type: "kj:collect",
            url: location.href,
            title: document.title,
            groupId: selected,
          }).then((result) => {
            if (result?.ok) {
              collected = { group: result.group, until: Date.now() + 1600 };
              clearTimeout(collectedTimer);
              render();
              const current = dock.querySelector<HTMLElement>(".collect");
              if (current) springPop(current);
              collectedTimer = window.setTimeout(() => {
                collected = undefined;
                render();
              }, 1600);
            }
          });
      },
      "collect",
    );
    const feedback = collected && collected.until > Date.now();
    collect.innerHTML = icon(!!existing || !!feedback);
    if (existing || feedback) collect.style.color = "var(--accent)";
    if (feedback) {
      const tip = document.createElement("span");
      tip.className = "tip";
      tip.style.opacity = "1";
      tip.textContent = "已收藏到「" + collected!.group + "」";
      collect.append(tip);
    }
    dock.append(collect);
  }
  function springValues() {
    const dt = 1 / 120,
      k = 420,
      c = 34;
    let x = 0.2,
      v = 0;
    const frames: Keyframe[] = [];
    for (let i = 0; i <= 120; i++) {
      v += (-k * (x - 1) - c * v) * dt;
      x += v * dt;
      frames.push({
        transform:
          "translateY(" +
          -6 * (1 - x) +
          "px) scale(" +
          x +
          "," +
          (0.6 + (0.4 * (x - 0.2)) / 0.8) +
          ")",
        opacity: Math.min(1, (x - 0.2) / 0.8),
      });
    }
    return frames;
  }
  function springPop(element: HTMLElement) {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let x = 1,
      v = 0;
    const frames: Keyframe[] = [];
    for (let i = 0; i <= 120; i++) {
      const target = i < 24 ? 1.2 : 1;
      frames.push({ transform: `scale(${x})` });
      v += (-520 * (x - target) - 38 * v) / 120;
      x += v / 120;
    }
    element.animate(frames, { duration: 1000 });
  }
  function show() {
    clearTimeout(closing);
    closing = 0;
    if (opened || host.style.display === "none") return;
    opened = true;
    render();
    dock.style.pointerEvents = "auto";
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    dock.animate(reduce ? [{ opacity: 0 }, { opacity: 1 }] : springValues(), {
      duration: reduce ? 150 : 1000,
      fill: "both",
    });
    Array.from(dock.children).forEach((el, i) =>
      (el as HTMLElement).animate(
        [
          { opacity: 0, transform: "translateY(4px)" },
          { opacity: 1, transform: "translateY(0)" },
        ],
        {
          duration: reduce ? 150 : 200,
          delay: reduce ? 0 : i * 14,
          fill: "both",
        },
      ),
    );
    handle.style.opacity = "0";
  }
  function hide() {
    clearTimeout(opening);
    clearTimeout(closing);
    closing = 0;
    clearMenu();
    if (!opened) return;
    opened = false;
    dock.animate(
      [
        { transform: "scale(1)", opacity: 1 },
        { transform: "translateY(-6px) scale(.2,.6)", opacity: 0 },
      ],
      {
        duration: matchMedia("(prefers-reduced-motion: reduce)").matches
          ? 150
          : 180,
        easing: "cubic-bezier(.55,0,1,.45)",
        fill: "both",
      },
    ).onfinish = () => {
      if (!opened) {
        dock.classList.remove("open");
        dock.style.pointerEvents = "none";
      }
    };
  }
  hot.addEventListener("click", show);
  handle.addEventListener("click", show);
  hot.addEventListener("pointerenter", () => {
    clearTimeout(opening);
    opening = window.setTimeout(show, 180);
  });
  hot.addEventListener("pointerleave", () => clearTimeout(opening));
  function scheduleHide() {
    if (opened && !closing) closing = window.setTimeout(hide, 200);
  }
  document.addEventListener("pointermove", (e) => {
    if (!data) return;
    const pos = data.settings.barPosition,
      near =
        pos === "top"
          ? e.clientY < 80
          : pos === "left"
            ? e.clientX < 80
            : e.clientX > innerWidth - 80;
    clearTimeout(fading);
    if (near && !opened) handle.style.opacity = ".9";
    else if (!opened)
      fading = window.setTimeout(() => (handle.style.opacity = "0"), 600);
    if (opened) {
      const rectangles = [hot, dock, ...(menu ? [menu] : [])].map((el) =>
        el.getBoundingClientRect(),
      );
      const inside = rectangles.some(
        (r) =>
          e.clientX >= r.left - 8 &&
          e.clientX <= r.right + 8 &&
          e.clientY >= r.top - 8 &&
          e.clientY <= r.bottom + 8,
      );
      if (inside) {
        clearTimeout(closing);
        closing = 0;
      } else scheduleHide();
    }
  }, { capture: true });
  document.documentElement.addEventListener("pointerleave", scheduleHide);
  window.addEventListener("blur", hide);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hide();
  });
  shadow.addEventListener("keydown", (e) => {
    const event = e as KeyboardEvent;
    if (!menu) return;
    const items = [...menu.querySelectorAll<HTMLButtonElement>("button")];
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const index = items.indexOf(shadow.activeElement as HTMLButtonElement);
      items[
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
              items.length
      ]?.focus();
    }
  });
  dock.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openMenu([
      {
        label: "在 " + location.hostname + " 上隐藏空境栏",
        click: () => void send({ type: "kj:hide" }),
      },
      {
        label: "空境栏设置",
        click: () => void send({ type: "kj:settings", section: "bar" }),
      },
    ]);
  });
  chrome.runtime.onMessage.addListener((m) => {
    if (m.type === "kj:toggle-bar") {
      if (opened) hide();
      else show();
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.data) {
      data = changes.data.newValue as AppData;
      void send({ type: "kj:page-state" }).then((result) => {
        existingId = result?.id;
        render();
      });
      render();
    }
  });
  void chrome.storage.local.get("data").then((value) => {
    data = value.data as AppData;
    void send({ type: "kj:page-state" }).then((result) => {
      existingId = result?.id;
      render();
    });
    render();
  });
  window.addEventListener("resize", render);
  document.addEventListener("fullscreenchange", render);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);
})();
