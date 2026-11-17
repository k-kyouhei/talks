// ============================================================================
// CUI AI News Fetcher for Scriptable
// Features: Multi-source, Round-Robin, Battery/Wi-Fi Guard, Size-Adaptive, Cache
//
// [Available Sources]
//   google     : Googleニュース AI検索（直近24時間）
//   zenn_trend : Zenn AIトピック トレンドランキング
//   zenn_new   : Zenn AIトピック 新着
//   qiita_ai   : Qiita AI/LLM/生成AI タグ・タイトル検索（最新順）
//   hatebu     : はてなブックマーク テクノロジー人気エントリー
//   hn         : Hacker News AI/LLM 最新ストーリー
//
// [Widget Parameter Patterns] (カンマ区切りで複数指定可)
//   (空欄)                   : 全6ソースをラウンドロビン + 低バッテリー時(20%以下)通信抑制ON
//   rr:zenn_trend,qiita_ai  : 指定したソースのみでラウンドロビン
//   zenn_trend              : 特定ソース固定（複数ウィジェット並置での同時監視向け）
//   wifi,rr                 : Wi-Fi接続時のみ通信し、全ソースをラウンドロビン
//   wifi,nobat,hn           : Wi-Fi限定 + 低バッテリー抑制解除 + Hacker News固定
//
// [Flags]
//   wifi  : Wi-Fi接続時のみ通信（非Wi-Fi時はキャッシュ表示）
//   nobat : 低バッテリー時（20%以下・非充電時）の通信抑制ガードを無効化
//   rr    : ラウンドロビン有効化（ソース複数指定時は自動ON）
// ============================================================================

// --- User Configuration ---
const USERNAME = "kkato";
const DEVICE_NAME = "KKiP17";
const THEME_COLOR = new Color("#00FF41"); // Terminal Green
const WARN_COLOR = new Color("#FFB000");  // Amber for Cached/Guard status
const BG_COLOR = new Color("#000000");
const FONT_MONO = "Menlo";

const LOW_BATTERY_THRESHOLD = 0.20; // 20%以下で通信抑制（充電中は除外）
const REQUEST_TIMEOUT_SEC = 10;     // タイムアウト秒数
const DEBUG_PARAM = "";             // アプリ内テスト用パラメータ（例: "wifi,rr:zenn_trend,qiita_ai"）

// --- Data Sources Definition ---
const SOURCES = {
  google: {
    label: "google",
    type: "rss",
    url: "https://news.google.com/rss/search?q=AI+人工知能+location:jp+when:1d&hl=ja&gl=JP&ceid=JP:ja",
    siteUrl: "https://news.google.com/search?q=AI+人工知能+location:jp+when:1d&hl=ja&gl=JP&ceid=JP:ja",
    excludeTitle: "Google ニュース"
  },
  zenn_trend: {
    label: "zenn/trend",
    type: "zenn_json",
    url: "https://zenn.dev/api/articles?topicname=ai&order=daily",
    siteUrl: "https://zenn.dev/topics/ai"
  },
  zenn_new: {
    label: "zenn/new",
    type: "zenn_json",
    url: "https://zenn.dev/api/articles?topicname=ai&order=latest",
    siteUrl: "https://zenn.dev/topics/ai?order=latest"
  },
  qiita_ai: {
    label: "qiita/ai",
    type: "qiita_json",
    url: "https://qiita.com/api/v2/items?page=1&per_page=20&query=tag:AI+OR+tag:LLM+OR+title:生成AI",
    siteUrl: "https://qiita.com/tags/ai"
  },
  hatebu: {
    label: "hatebu/it",
    type: "rss",
    url: "https://b.hatena.ne.jp/hotentry/it.rss",
    siteUrl: "https://b.hatena.ne.jp/hotentry/it",
    excludeTitle: "はてなブックマーク"
  },
  hn: {
    label: "hn/ai",
    type: "hn_json",
    url: "https://hn.algolia.com/api/v1/search_by_date?query=AI+OR+LLM&tags=story&hitsPerPage=20",
    siteUrl: "https://hn.algolia.com/?q=AI+OR+LLM"
  }
};

const ALL_SOURCE_KEYS = Object.keys(SOURCES);

// --- Storage & Cache Setup ---
const fm = FileManager.local();
const BASE_DIR = fm.joinPath(fm.documentsDirectory(), "ai_news_widget");
if (!fm.fileExists(BASE_DIR)) {
  fm.createDirectory(BASE_DIR);
}

function readJson(filename, fallback = null) {
  const path = fm.joinPath(BASE_DIR, filename);
  if (!fm.fileExists(path)) return fallback;
  try {
    return JSON.parse(fm.readString(path));
  } catch (_) {
    return fallback;
  }
}

function writeJson(filename, data) {
  const path = fm.joinPath(BASE_DIR, filename);
  fm.writeString(path, JSON.stringify(data));
}

// --- Parameter Parser ---
function parseWidgetParameter(rawParam) {
  const tokens = (rawParam || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  let wifiOnly = false;
  let ignoreBatteryGuard = false;
  let roundRobinMode = false;
  let selectedSources = [];

  for (const token of tokens) {
    if (token === "wifi") {
      wifiOnly = true;
    } else if (token === "nobat") {
      ignoreBatteryGuard = true;
    } else if (token === "rr") {
      roundRobinMode = true;
    } else if (token.startsWith("rr:")) {
      roundRobinMode = true;
      const list = token.slice(3).split(/[\s|+]/).map(s => s.trim()).filter(k => SOURCES[k]);
      selectedSources.push(...list);
    } else if (SOURCES[token]) {
      selectedSources.push(token);
    }
  }

  if (selectedSources.length === 0) {
    selectedSources = [...ALL_SOURCE_KEYS];
    roundRobinMode = true;
  } else if (selectedSources.length > 1) {
    roundRobinMode = true;
  }

  return { wifiOnly, ignoreBatteryGuard, roundRobinMode, selectedSources };
}

// --- Target Source Resolver (with Round-Robin State) ---
function resolveTargetSource(options) {
  const { roundRobinMode, selectedSources } = options;
  if (!roundRobinMode || selectedSources.length === 1) {
    return selectedSources[0];
  }

  const stateKey = selectedSources.join("_");
  const state = readJson("rr_state.json", {});
  const currentIndex = typeof state[stateKey] === "number" ? state[stateKey] : 0;
  const targetKey = selectedSources[currentIndex % selectedSources.length];

  state[stateKey] = (currentIndex + 1) % selectedSources.length;
  writeJson("rr_state.json", state);

  return targetKey;
}

// --- HTML Entity Decoder (10進数・16進数・サロゲートペア対応) ---
function decodeHtmlEntities(str) {
  return str
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;|&#x27;/gi, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/\s+/g, " ")
    .trim();
}

// --- Fetch & Parse per Source Type ---
async function fetchArticles(sourceKey) {
  const src = SOURCES[sourceKey];
  const req = new Request(src.url);
  req.timeoutInterval = REQUEST_TIMEOUT_SEC;
  req.headers = { "User-Agent": "Scriptable-AINewsWidget/2.0" };

  if (src.type === "rss") {
    const xml = await req.loadString();
    const items = xml.match(/<item[\s\S]*?<\/item>/g) || [];
    const titles = [];

    for (const item of items) {
      const m = item.match(/<title>([\s\S]*?)<\/title>/);
      if (!m) continue;
      const title = decodeHtmlEntities(m[1]);
      if (title && title !== src.excludeTitle) {
        titles.push(title);
      }
    }
    return titles;
  }

  const json = await req.loadJSON();

  if (src.type === "zenn_json") {
    return (json.articles || []).map(a => decodeHtmlEntities(a.title || "")).filter(Boolean);
  }

  if (src.type === "qiita_json") {
    return (Array.isArray(json) ? json : []).map(a => decodeHtmlEntities(a.title || "")).filter(Boolean);
  }

  if (src.type === "hn_json") {
    return (json.hits || []).map(h => decodeHtmlEntities(h.title || "")).filter(Boolean);
  }

  return [];
}

// --- Widget Size Layout Profile ---
function getLayoutProfile(family) {
  switch (family) {
    case "small":
      return {
        maxItems: 5,
        lineLimit: 2,
        fontSize: 7.5,
        headerFontSize: 7.5,
        footerFontSize: 6,
        spacerAfterHeader: 3,
        itemSpacer: 2.5,
        padding: [5, 8, 5, 8],
        compact: true
      };
    case "large":
    case "extraLarge":
      return {
        maxItems: 18,
        lineLimit: 1,
        fontSize: 9,
        headerFontSize: 8.5,
        footerFontSize: 7,
        spacerAfterHeader: 6,
        itemSpacer: 3,
        padding: [8, 12, 8, 12],
        compact: false
      };
    case "medium":
    default:
      return {
        maxItems: 9,
        lineLimit: 1,
        fontSize: 9,
        headerFontSize: 8.5,
        footerFontSize: 7,
        spacerAfterHeader: 6,
        itemSpacer: 3,
        padding: [6, 12, 6, 12],
        compact: false
      };
  }
}

// --- Main Execution ---
const rawParam = args.widgetParameter || DEBUG_PARAM;
const options = parseWidgetParameter(rawParam);
const targetKey = resolveTargetSource(options);
const targetSource = SOURCES[targetKey];
const family = config.widgetFamily || "medium";
const layout = getLayoutProfile(family);

let titles = [];
let statusLabel = "LIVE";
let isCachedMode = false;
let fetchedTimestamp = null;

// Guard Check: Battery & Wi-Fi
const isLowBattery = !options.ignoreBatteryGuard && !Device.isCharging() && Device.batteryLevel() <= LOW_BATTERY_THRESHOLD;
const isBlockedByWifi = options.wifiOnly && !Device.isUsingWifi();

if (isLowBattery || isBlockedByWifi) {
  isCachedMode = true;
  statusLabel = isLowBattery ? "CACHE:LOW_BAT" : "CACHE:NO_WIFI";
  const cached = readJson(`cache_${targetKey}.json`) || readJson("cache_latest.json");
  if (cached && Array.isArray(cached.titles)) {
    titles = cached.titles;
    fetchedTimestamp = cached.timestamp;
  }
} else {
  try {
    titles = await fetchArticles(targetKey);
    if (titles.length > 0) {
      const payload = { source: targetKey, titles, timestamp: Date.now() };
      writeJson(`cache_${targetKey}.json`, payload);
      writeJson("cache_latest.json", payload);
      fetchedTimestamp = payload.timestamp;
      statusLabel = options.roundRobinMode ? "LIVE:RR" : "LIVE";
    } else {
      throw new Error("EMPTY_FEED");
    }
  } catch (e) {
    isCachedMode = true;
    statusLabel = "CACHE:NET_ERR";
    const cached = readJson(`cache_${targetKey}.json`) || readJson("cache_latest.json");
    if (cached && Array.isArray(cached.titles)) {
      titles = cached.titles;
      fetchedTimestamp = cached.timestamp;
    }
  }
}

// --- Build Widget UI ---
const widget = new ListWidget();
widget.backgroundColor = BG_COLOR;
widget.setPadding(...layout.padding);
widget.url = targetSource.siteUrl;

// Header: Prompt Style
const headerStr = layout.compact
  ? `> ~/ai_news/${targetSource.label}`
  : `> ${USERNAME}@${DEVICE_NAME}:~/ai_news/${targetSource.label}$ watch -n 600 fetch_news`;

const headerText = widget.addText(headerStr);
headerText.font = new Font(FONT_MONO, layout.headerFontSize);
headerText.textColor = THEME_COLOR;
headerText.lineLimit = 1;

widget.addSpacer(layout.spacerAfterHeader);

// Body: Articles List
if (titles.length > 0) {
  const displayTitles = titles.slice(0, layout.maxItems);
  for (const title of displayTitles) {
    const itemStack = widget.addStack();
    itemStack.layoutHorizontally();

    const bullet = itemStack.addText("» ");
    bullet.font = new Font(FONT_MONO, layout.fontSize);
    bullet.textColor = isCachedMode ? WARN_COLOR : THEME_COLOR;

    const titleText = itemStack.addText(title);
    titleText.font = new Font(FONT_MONO, layout.fontSize);
    titleText.textColor = THEME_COLOR;
    titleText.lineLimit = layout.lineLimit;

    widget.addSpacer(layout.itemSpacer);
  }
} else {
  const errText = widget.addText(`[ WARN: ${statusLabel} / NO_CACHE ]`);
  errText.font = new Font(FONT_MONO, layout.fontSize);
  errText.textColor = Color.red();
}

widget.addSpacer();

// Footer: CUI Status Line
const footerStack = widget.addStack();
footerStack.layoutHorizontally();

const df = new DateFormatter();
df.dateFormat = layout.compact ? "HH:mm" : "HH:mm:ss";
const displayDate = fetchedTimestamp ? new Date(fetchedTimestamp) : new Date();

if (layout.compact) {
  const compactStatus = footerStack.addText(`${statusLabel} | ${df.string(displayDate)}`);
  compactStatus.font = new Font(FONT_MONO, layout.footerFontSize);
  compactStatus.textColor = isCachedMode ? WARN_COLOR : THEME_COLOR;
  compactStatus.textOpacity = 0.6;
} else {
  const statusText = footerStack.addText(`SRC:${targetKey.toUpperCase()} | ${statusLabel}`);
  statusText.font = new Font(FONT_MONO, layout.footerFontSize);
  statusText.textColor = isCachedMode ? WARN_COLOR : THEME_COLOR;
  statusText.textOpacity = 0.65;

  footerStack.addSpacer();

  const timeText = footerStack.addText(`T_STAMP:${df.string(displayDate)}`);
  timeText.font = new Font(FONT_MONO, layout.footerFontSize);
  timeText.textColor = THEME_COLOR;
  timeText.textOpacity = 0.45;
}

if (config.runsInWidget) {
  Script.setWidget(widget);
} else {
  widget.presentMedium();
}
Script.complete();