import { useEffect, useState } from "react";
import { Button, Dropdown, Toggle } from "../../components/Common/Common";
import { useStore } from "../../app/store";
import { ANDROID, STORE } from "../../lib/build";
import { pairCommand } from "./bridge";

async function allowOrigin(origin: string) {
  if (ANDROID || typeof chrome === "undefined" || !chrome.runtime?.id) return;
  if (origin === "https://kongjing.inc.re") return;
  if (!await chrome.permissions.request({ origins: [origin + "/*"] })) throw Error("PERMISSION");
}

export function V3Advanced() {
  const status = useStore((s) => s.status);
  const [backend, setBackend] = useState<"cloudflare" | "edge">(status.backend || "cloudflare");
  const [url, setUrl] = useState(status.relayUrl);
  const [turnUrl, setTurnUrl] = useState(status.turnUrl || "");
  const [turnUser, setTurnUser] = useState(status.turnUser || "");
  const [credential, setCredential] = useState("");
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setBackend(status.backend || "cloudflare"); setUrl(status.relayUrl);
    setTurnUrl(status.turnUrl || ""); setTurnUser(status.turnUser || "");
  }, [status.backend, status.relayUrl, status.turnUrl, status.turnUser]);
  return <details className="pair-advanced sync-v3-advanced">
    <summary>高级</summary>
    <label className="field-label">部署平台</label>
    <Dropdown label="部署平台" value={backend} items={[
      { value: "cloudflare", label: "Cloudflare Workers（默认）" },
      { value: "edge", label: "EdgeOne Makers（EO）" },
    ]} onChange={(value) => {
      setBackend(value as "cloudflare" | "edge");
      if (value === "cloudflare") setUrl("https://kongjing.inc.re");
      else if (url === "https://kongjing.inc.re") setUrl("");
    }} />
    <label className="field-label">同步服务器<input aria-label="同步服务器" placeholder="https://sync.example.com" value={url} onChange={(e) => setUrl(e.target.value)} /></label>
    <Button variant="secondary" busy={busy} onClick={() => void (async () => {
      setBusy(true); setResult("");
      try {
        const target = new URL(url.trim());
        if (!(target.protocol === "https:" || (target.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname))) || target.username || target.password) throw Error("URL");
        await allowOrigin(target.origin);
        const applied = await pairCommand("configure", { url: target.origin, backend, directOnly: "false" });
        if (applied?.pair?.view === "failure") { setResult("更换同步平台或服务器需要先离开配对组，再重新配对"); return; }
        const response = await fetch(target.origin + (backend === "cloudflare" ? "/v1/health" : "/v2/health"), { credentials: "omit", signal: AbortSignal.timeout(8000) });
        if (!response.ok || !(await response.json()).ok) throw Error("NETWORK");
        setResult("已保存，连接成功");
      } catch (error) {
        setResult(error instanceof Error && error.message === "PERMISSION" ? "未授予此服务器访问权限" : "暂时无法连接。已保存的服务器会在网络恢复后重试，本机功能仍可使用。");
      } finally { setBusy(false); }
    })()}>保存并测试连接</Button>
    {result && <p className="help" role="status">{result}</p>}
    {!STORE && status.backend === "edge" && <>
      <div className="relay-setting-row"><span>仅直连，不在服务器保存数据<small>离线设备需要与其他设备同时在线才能接收更新。</small></span><Toggle label="仅直连，不在服务器保存数据" value={!!status.directOnly} onChange={() => void pairCommand("configure", { directOnly: String(!status.directOnly) })} /></div>
      <label className="field-label">TURN 地址<input value={turnUrl} onChange={(e) => setTurnUrl(e.target.value)} /></label>
      <label className="field-label">用户名<input autoComplete="off" value={turnUser} onChange={(e) => setTurnUser(e.target.value)} /></label>
      <label className="field-label">凭证<input type="password" autoComplete="new-password" placeholder={status.hasTurnCredential ? "已保存" : ""} value={credential} onChange={(e) => setCredential(e.target.value)} /></label>
      <Button variant="secondary" onClick={() => void (async () => {
        const applied = await pairCommand("configure", { turnUrl: turnUrl.trim(), turnUser, ...(credential || !turnUrl ? { turnCredential: credential } : {}) });
        setCredential(""); setResult(applied?.pair?.view === "failure" ? "无法保存 TURN 设置" : "已保存");
      })()}>保存 TURN</Button>
    </>}
    <p className="help">默认地址 https://kongjing.inc.re/ 由 Cloudflare 承载。使用备案域名部署 EO 可改善国内连接体验。所有设备需选择同一平台和服务器；更换服务器需要重新配对。</p>
  </details>;
}
