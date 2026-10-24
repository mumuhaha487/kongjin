import type { SyncStatus } from "./types";
import { STORE } from "../../lib/build";

export const relativeTime = (time?: number) => {
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - (time || Date.now())) / 60000),
  );
  return minutes < 1
    ? "刚刚"
    : minutes < 60
      ? minutes + " 分钟前"
      : Math.floor(minutes / 60) + " 小时前";
};

export const syncPhase = (status: SyncStatus) =>
  !status.paired
    ? "offline"
    : status.error
      ? "error"
      : status.syncing
        ? "syncing"
        : status.connection === "online"
          ? "online"
          : "offline";

export const syncMessage = (status: SyncStatus) =>
  ({
    online: "已连接",
    syncing: "正在同步…",
    offline: "离线 · 恢复网络后自动同步",
    error: "同步出错 · 点击重试",
  })[syncPhase(status)];

export const syncFooter = (status: SyncStatus) =>
  !status.paired
    ? "仅本机"
    : !STORE && status.transport
      ? status.transport === "offline" ? "离线" : (status.transport === "direct" ? "直连" : "中转") + (status.lastSyncAt ? " · " + relativeTime(status.lastSyncAt) + "同步" : "")
    : syncMessage(status) +
      (syncPhase(status) === "online" && status.lastSyncAt
        ? " · " + relativeTime(status.lastSyncAt) + "同步"
        : "");
