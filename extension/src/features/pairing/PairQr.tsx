import { useMemo } from "react";
import qrcode from "qrcode-generator";
import { formatPairCode } from "./types";
export function pairQr(code: string) {
  const formatted = formatPairCode(code);
  if (!formatted) throw Error("BAD_CODE");
  const content = "kongjing://pair?code=" + formatted;
  const qr = qrcode(0, "M");
  qr.addData(content, "Byte");
  qr.make();
  const count = qr.getModuleCount();
  let path = "";
  for (let y = 0; y < count; y++)
    for (let x = 0; x < count; x++)
      if (qr.isDark(y, x)) path += `M${x + 4} ${y + 4}h1v1h-1z`;
  return { content, path, size: count + 8 };
}
export function PairQr({ code }: { code: string }) {
  const qr = useMemo(() => pairQr(code), [code]);
  return (
    <div className="pair-qr-card">
      <svg
        role="img"
        aria-label="扫描二维码加入配对组"
        data-content={qr.content}
        width="160"
        height="160"
        viewBox={`0 0 ${qr.size} ${qr.size}`}
        shapeRendering="crispEdges"
      >
        <rect width={qr.size} height={qr.size} fill="#fff" />
        <path d={qr.path} fill="#000" />
      </svg>
    </div>
  );
}
