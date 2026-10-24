import { useEffect, useState, type CSSProperties } from "react";
import { hash } from "../../lib/favicon";
import { useStore } from "../../app/store";
import type { BookmarkIcon } from "../../lib/model";
export function TileIcon({
  title,
  url,
  avatar = false,
  icon,
  src,
}: {
  title: string;
  url: string;
  avatar?: boolean;
  icon?: BookmarkIcon;
  src?: string;
}) {
  const style = useStore((s) => s.data.settings.iconStyle),
    bookmarks = useStore((s) => s.data.bookmarks);
  const value = icon || bookmarks.find((b) => b.url === url)?.icon;
  const image =
    src ||
    (style !== "letter" && value?.mode !== "letter"
      ? value?.dataUrl || value?.url
      : undefined);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [image]);
  let host = url;
  try {
    host = new URL(url).hostname;
  } catch {
    /* nickname hash */
  }
  return (
    <span
      className={
        "tile-icon " +
        (avatar ? "avatar " : "") +
        (image && !failed ? "website" : "letter")
      }
      style={{ "--hue": hash(host) % 360 } as CSSProperties}
    >
      {image && !failed ? (
        <img
          data-tone={avatar ? undefined : value?.tone}
          src={image}
          alt=""
          referrerPolicy="no-referrer"
          draggable={false}
          onError={() => {
            setFailed(true);
            if (avatar && src?.startsWith("http"))
              useStore.getState().toast("头像链接无法加载");
          }}
        />
      ) : (
        Array.from(title || "空")[0].toUpperCase()
      )}
    </span>
  );
}
