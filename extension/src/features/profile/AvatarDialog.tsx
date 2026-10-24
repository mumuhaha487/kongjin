import { useRef, useState } from "react";
import { motion } from "motion/react";
import { useStore } from "../../app/store";
import { Modal, Button, Segments } from "../../components/Common/Common";
import { TileIcon } from "../../components/TileIcon/TileIcon";
import { compressImage, blobDataUrl } from "../../lib/images";
import { normalizeUrl } from "../../lib/validation";
export function AvatarDialog() {
  const s = useStore(),
    p = s.data.profile,
    [mode, setMode] = useState("upload"),
    [url, setUrl] = useState(p.avatar?.startsWith("http") ? p.avatar : ""),
    [error, setError] = useState(""),
    [size, setSize] = useState(""),
    [busy, setBusy] = useState(false),
    upload = useRef<HTMLInputElement>(null);
  async function apply() {
    const valid = normalizeUrl(url);
    if (!valid) {
      setError("头像链接无法加载");
      return;
    }
    setBusy(true);
    const img = new Image();
    img.referrerPolicy = "no-referrer";
    img.onload = () => {
      s.profile({ avatar: valid });
      setError("");
      setSize("");
      setBusy(false);
    };
    img.onerror = () => {
      setError("头像链接无法加载");
      setBusy(false);
    };
    img.src = valid;
  }
  return (
    <Modal title="头像" source={s.overlay?.source}>
      <h1>头像</h1>
      <motion.div
        key={p.avatar}
        className="avatar-preview"
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
      >
        <TileIcon title={p.nickname} url={p.nickname} avatar src={p.avatar} />
      </motion.div>
      <div className="avatar-options">
        <Segments
          id="avatar-mode"
          value={mode}
          items={[
            { value: "upload", label: "上传图片" },
            { value: "link", label: "使用链接" },
            { value: "remove", label: "移除" },
          ]}
          onChange={(value) => {
            setMode(value);
            setError("");
            if (value === "upload") upload.current?.click();
            if (value === "remove") {
              s.profile({ avatar: undefined });
              setSize("");
            }
          }}
        />
      </div>
      <input
        ref={upload}
        type="file"
        hidden
        accept="image/png,image/jpeg,image/webp,image/gif"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          setBusy(true);
          setError("");
          try {
            const result = await compressImage(file, "avatar");
            s.profile({ avatar: await blobDataUrl(result) });
            setSize("已压缩为 " + (result.size / 1024).toFixed(1) + " KB");
          } catch (e) {
            setError(e instanceof Error ? e.message : "无法读取这张图片");
          } finally {
            setBusy(false);
          }
        }}
      />
      {mode === "upload" && (
        <div className="avatar-help">
          <Button
            variant="secondary"
            busy={busy}
            onClick={() => upload.current?.click()}
          >
            选择图片
          </Button>
        </div>
      )}
      {mode === "link" && (
        <motion.div
          className="avatar-link"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
        >
          <input
            aria-label="头像网址"
            placeholder="https://"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <Button busy={busy} onClick={() => void apply()}>
            应用
          </Button>
        </motion.div>
      )}
      {size && <p className="help avatar-help">{size}</p>}
      {error && <p className="field-error avatar-help">{error}</p>}
      <p className="help avatar-help">
        头像只保存在本机；开启配对后，会以加密形式同步到你的其他设备。
      </p>
      <div className="dialog-actions">
        <Button onClick={() => s.open(null)}>完成</Button>
      </div>
    </Modal>
  );
}
