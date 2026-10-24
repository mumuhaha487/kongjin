import { ANDROID } from "./build";
export const accents = ["sky", "mist", "dusk", "nebula", "sakura"] as const;
export interface Settings {
  theme: "system" | "dark" | "light";
  accent: (typeof accents)[number];
  background: "kongjing" | "solid" | "image";
  imageUrl: string;
  animated: boolean;
  smoothFirst: boolean;
  grain: boolean;
  hour24: boolean;
  seconds: boolean;
  greeting: boolean;
  newTab: boolean;
  history: boolean;
  iconStyle: "favicon" | "letter";
  labels: boolean;
  columns: 6 | 7 | 8;
  barEnabled: boolean;
  barPosition: "top" | "left" | "right";
  hiddenSites: string[];
  quickGroup: string;
  autoClose: boolean;
  updatedAt: number;
}
export interface Group {
  id: string;
  name: string;
  order: number;
  updatedAt: number;
}
export interface Bookmark {
  id: string;
  groupId: string;
  title: string;
  url: string;
  order: number;
  createdAt: number;
  icon: BookmarkIcon;
  updatedAt: number;
}
export interface Engine {
  id: string;
  name: string;
  url: string;
  updatedAt: number;
}
export interface Tombstone {
  id: string;
  kind: "group" | "bookmark" | "searchEngine";
  deletedAt: number;
}
export interface AppData {
  schema: 2;
  profile: Profile;
  settings: Settings;
  groups: Group[];
  bookmarks: Bookmark[];
  tombstones: Tombstone[];
  searchEngines: Engine[];
}
export interface BookmarkIcon {
  mode: "auto" | "letter" | "custom";
  tone?: "dark" | "light" | "normal";
  dataUrl?: string;
  url?: string;
  fetchedAt?: number;
  failedAt?: number;
}
export interface Profile {
  nickname: string;
  avatar?: string;
  updatedAt: number;
}
export const defaultSettings: Settings = {
  theme: ANDROID ? "system" : "dark",
  accent: "sky",
  background: "kongjing",
  imageUrl: "",
  animated: true,
  smoothFirst: false,
  grain: true,
  hour24: true,
  seconds: false,
  greeting: true,
  newTab: false,
  history: true,
  iconStyle: "favicon",
  labels: true,
  columns: 8,
  barEnabled: false,
  barPosition: "top",
  hiddenSites: [],
  quickGroup: "default-common",
  autoClose: true,
  updatedAt: 0,
};
export function defaults(): AppData {
  return {
    schema: 2,
    profile: { nickname: "", updatedAt: 0 },
    settings: structuredClone(defaultSettings),
    groups: [{ id: "default-common", name: "常用", order: 0, updatedAt: 0 }],
    bookmarks: [
      ["github", "GitHub", "https://github.com"],
      ["bilibili", "哔哩哔哩", "https://www.bilibili.com"],
      ["zhihu", "知乎", "https://www.zhihu.com"],
      ["youtube", "YouTube", "https://www.youtube.com"],
      ["gmail", "Gmail", "https://mail.google.com"],
      ["sspai", "少数派", "https://sspai.com"],
    ].map(([id, title, url], order) => ({
      id: `default-${id}`,
      title,
      url,
      order,
      groupId: "default-common",
      icon: { mode: "auto" },
      createdAt: 0,
      updatedAt: 0,
    })),
    tombstones: [],
    searchEngines: [],
  };
}
export const builtins: Engine[] = [
  { id: "default", name: "默认搜索", url: "", updatedAt: 0 },
  {
    id: "google",
    name: "Google",
    url: "https://www.google.com/search?q=%s",
    updatedAt: 0,
  },
  {
    id: "bing",
    name: "必应",
    url: "https://www.bing.com/search?q=%s",
    updatedAt: 0,
  },
  {
    id: "baidu",
    name: "百度",
    url: "https://www.baidu.com/s?wd=%s",
    updatedAt: 0,
  },
  {
    id: "duckduckgo",
    name: "DuckDuckGo",
    url: "https://duckduckgo.com/?q=%s",
    updatedAt: 0,
  },
];
export function cleanSettings(settings: Settings): Settings {
  const clean = { ...settings, smoothFirst: settings.smoothFirst ?? false } as Settings & { engine?: unknown };
  delete clean.engine;
  return clean;
}
export const ordered = <T extends { order: number; id: string }>(a: T[]) =>
  [...a].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id, "en"));
