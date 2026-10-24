import type { Engine } from "../../lib/model";
import { extensionEnvironment } from "../../lib/storage";
import { ANDROID, STORE } from "../../lib/build";
import { nativeOpen } from "../../platform/native";
export function navigate(url: string, newTab = false) {
  if (ANDROID) {
    nativeOpen(url, newTab);
    return;
  }
  if (newTab) window.open(url, "_blank", "noopener,noreferrer");
  else window.location.assign(url);
}
export async function executeSearch(
  value: string,
  engine: Engine,
  newTab: boolean,
) {
  const text = value.trim();
  if (!text) return;
  if ((!STORE || !extensionEnvironment()) && engine.id !== "default")
    return navigate(engine.url.replace("%s", encodeURIComponent(text)), newTab);
  if (!ANDROID && extensionEnvironment()) {
    await chrome.search.query({
      text,
      disposition: newTab ? "NEW_TAB" : "CURRENT_TAB",
    });
    return;
  }
  console.debug("[空境] 非扩展预览：默认搜索回退到必应。");
  navigate("https://www.bing.com/search?q=" + encodeURIComponent(text), newTab);
}
