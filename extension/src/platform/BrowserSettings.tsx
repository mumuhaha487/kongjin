import { useEffect, useSyncExternalStore } from "react";
import { Check } from "lucide-react";
import { browserSettings, mobileEngines } from "./android-settings";
import { useStore } from "../app/store";
import { Dropdown, Toggle } from "../components/Common/Common";
import { browserPrefs } from "./browser-prefs";
import { nativeCall } from "./native";
export function BrowserSettings() {
  const s = useStore(),
    browser = useSyncExternalStore(
      browserSettings.subscribe,
      browserSettings.get,
    ),
    prefs = useSyncExternalStore(browserPrefs.subscribe, browserPrefs.get);
  useEffect(() => browserPrefs.refresh(), []);
  return (
    <section id="settings-browser">
      <h3>浏览器</h3>
      <div className="setting-row">
        <span>默认搜索引擎</span>
        <Dropdown
          label="默认搜索引擎"
          value={browser.engine}
          items={mobileEngines(s.data).map((e) => ({
            value: e.id,
            label: e.name,
          }))}
          onChange={(engine) => void browserSettings.set({ engine })}
        />
      </div>
      <div className="setting-row">
        <span>在新标签页打开书签</span>
        <Toggle
          label="在新标签页打开书签"
          value={browser.bookmarkNewTab}
          onChange={() =>
            void browserSettings.set({
              bookmarkNewTab: !browser.bookmarkNewTab,
            })
          }
        />
      </div>
      <div className="setting-row">
        <span>清除浏览数据</span>
        <button
          className="text-button danger-text"
          onClick={() => s.open({ type: "clear-browser" })}
        >
          清除
        </button>
      </div>
      {prefs && (
        <div className="native-browser-prefs">
          <div className="setting-row">
            <span>默认浏览器</span>
            {prefs.isDefault ? (
              <span className="browser-default-status">
                <Check size={14} aria-hidden="true" />
                已是默认
              </span>
            ) : (
              <button
                className="text-button browser-default-action"
                onClick={() => nativeCall("requestDefaultBrowser")}
              >
                去设置
              </button>
            )}
          </div>
          {prefs.darkSupported && (
            <div className="setting-row">
              <span>网页深色模式</span>
              <Dropdown
                label="网页深色模式"
                value={prefs.darkMode}
                items={[
                  { value: "follow", label: "跟随主题" },
                  { value: "on", label: "始终" },
                  { value: "off", label: "关闭" },
                ]}
                onChange={(value) =>
                  browserPrefs.setDarkMode(value as "follow" | "on" | "off")
                }
              />
            </div>
          )}
          <div className="setting-row browser-text-size">
            <label htmlFor="browser-text-zoom">网页文字大小</label>
            <span className="muted">{prefs.textZoom}%</span>
            <input
              id="browser-text-zoom"
              type="range"
              min="80"
              max="150"
              step="10"
              value={prefs.textZoom}
              onChange={(event) =>
                browserPrefs.setTextZoom(Number(event.target.value))
              }
            />
          </div>
          <p
            className="browser-text-preview"
            style={{ fontSize: (12 * prefs.textZoom) / 100 }}
          >
            空境让每一次打开都更安静。
          </p>
        </div>
      )}
    </section>
  );
}
