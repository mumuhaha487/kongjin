import { useRef, useState } from "react";
import { Eye, EyeOff, Copy, Check } from "lucide-react";
import { useStore, importData } from "../../app/store";
import { Button, Segments, Choice } from "../../components/Common/Common";
import {
  encodeBackup,
  decodeBackup,
  backupObject,
  backupFilename,
  backupLimit,
  type Imported,
} from "../../lib/backup";
import { download } from "../../lib/download";
import { blobDataUrl } from "../../lib/images";
import { imageFile } from "../../lib/storage";
import { visibleTimeout } from "../../lib/visibility";
export function DataSettings() {
  const s = useStore.getState(),
    [exp, setExp] = useState("file"),
    [imp, setImp] = useState("file"),
    [include, setInclude] = useState(false),
    [pass, setPass] = useState(""),
    [visible, setVisible] = useState(false),
    [code, setCode] = useState(""),
    [text, setText] = useState(""),
    [importPass, setImportPass] = useState(""),
    [parsed, setParsed] = useState<Imported>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [copied, setCopied] = useState(false),
    [replace, setReplace] = useState(false),
    upload = useRef<HTMLInputElement>(null);
  async function parse(value: string) {
    setError("");
    setParsed(undefined);
    setBusy(true);
    try {
      setParsed(await decodeBackup(value, importPass));
    } catch (e) {
      setError(e instanceof Error ? e.message : "不是空境的导入码或备份文件");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section id="settings-data">
      <h3>数据</h3>
      <div className="setting-row">
        <span>导出</span>
        <Segments
          id="export-mode"
          value={exp}
          items={[
            { value: "file", label: "文件" },
            { value: "text", label: "文本码" },
          ]}
          onChange={setExp}
        />
      </div>
      <div className="data-controls">
        {exp === "file" ? (
          <>
            <Choice
              label="包含背景图片"
              checked={include}
              onChange={() => setInclude(!include)}
            />
            <Button
              onClick={() =>
                void (async () => {
                  const bg = include ? await imageFile() : undefined;
                  download(
                    backupFilename(),
                    JSON.stringify(
                      backupObject(
                        useStore.getState().data,
                        bg ? await blobDataUrl(bg) : undefined,
                      ),
                      null,
                      2,
                    ),
                  );
                })()
              }
            >
              导出文件
            </Button>
          </>
        ) : (
          <>
            <div className="password-row">
              <input
                aria-label="导出口令"
                type={visible ? "text" : "password"}
                placeholder="口令（可选）"
                value={pass}
                onChange={(e) => setPass(e.target.value)}
              />
              <button
                aria-label={visible ? "隐藏口令" : "显示口令"}
                onClick={() => setVisible(!visible)}
              >
                {visible ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            <Button
              busy={busy}
              onClick={() =>
                void (async () => {
                  setBusy(true);
                  try {
                    setCode(await encodeBackup(useStore.getState().data, pass));
                  } finally {
                    setBusy(false);
                  }
                })()
              }
            >
              生成导入码
            </Button>
            {code && (
              <>
                <div className="code-output">
                  <textarea
                    aria-label="生成的导入码"
                    className="code-text"
                    readOnly
                    value={code}
                  />
                  <button
                    aria-label="复制导入码"
                    onClick={() =>
                      void navigator.clipboard.writeText(code).then(() => {
                        setCopied(true);
                        s.toast("已复制导入码");
                        visibleTimeout(() => setCopied(false), 2600);
                      })
                    }
                  >
                    {copied ? <Check size={16} /> : <Copy size={16} />}
                  </button>
                </div>
                <p className="code-size">
                  约 {(new TextEncoder().encode(code).length / 1024).toFixed(1)}{" "}
                  KB
                </p>
              </>
            )}
            <p className="help">
              {pass
                ? "已用口令加密，导入时需要输入同一口令"
                : "未设置口令：任何拿到导入码的人都能读取内容"}
            </p>
          </>
        )}
      </div>
      <div className="setting-row">
        <span>导入</span>
        <Segments
          id="import-mode"
          value={imp}
          items={[
            { value: "file", label: "文件" },
            { value: "text", label: "文本码" },
          ]}
          onChange={setImp}
        />
      </div>
      <div className="data-controls">
        {imp === "file" ? (
          <Button variant="secondary" onClick={() => upload.current?.click()}>
            选择文件
          </Button>
        ) : (
          <>
            <textarea
              className="code-text"
              aria-label="粘贴导入码"
              placeholder="粘贴导入码"
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setError("");
                setParsed(undefined);
              }}
            />
            {text.trim().startsWith("KJ2E.") && (
              <input
                aria-label="导入口令"
                type="password"
                placeholder="口令"
                value={importPass}
                onChange={(e) => setImportPass(e.target.value)}
              />
            )}
            <Button
              variant="secondary"
              busy={busy}
              onClick={() => void parse(text)}
            >
              解析
            </Button>
          </>
        )}
        <input
          type="file"
          ref={upload}
          accept=".json,application/json"
          hidden
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            if (file.size > backupLimit) {
              setError("导入内容需小于 5 MB");
              return;
            }
            await parse(await file.text());
            e.target.value = "";
          }}
        />
        {error && (
          <p role="alert" className="field-error">
            {error}
          </p>
        )}
        {parsed && (
          <div className="preview-card">
            <p>
              将导入 {parsed.data.groups.length} 个分组、
              {parsed.data.bookmarks.length} 个书签、个人资料与设置
            </p>
            <Choice
              type="radio"
              name="import-strategy"
              label="合并到当前数据（推荐）"
              checked={!replace}
              onChange={() => setReplace(false)}
            />
            <Choice
              type="radio"
              name="import-strategy"
              label="替换当前数据"
              checked={replace}
              onChange={() => setReplace(true)}
            />
            <Button
              onClick={async () => {
                if (replace)
                  s.open({
                    type: "replace",
                    data: parsed.data,
                    background: parsed.background,
                  });
                else {
                  try {
                    await importData(parsed.data);
                  } catch {
                    return;
                  }
                  if (parsed.background)
                    void fetch(parsed.background)
                      .then((r) => r.blob())
                      .then(imageFile);
                  s.toast("导入成功");
                  setParsed(undefined);
                }
              }}
            >
              导入
            </Button>
          </div>
        )}
      </div>
      <div className="setting-row reset-row">
        <div className="reset-label">
          <span>恢复默认</span>
          <small>清除本机所有书签与设置，恢复为初始状态</small>
        </div>
        <button
          className="text-button danger-text"
          onClick={() => s.open({ type: "reset" })}
        >
          重置
        </button>
      </div>
    </section>
  );
}
