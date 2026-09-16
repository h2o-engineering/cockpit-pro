/*
 * Studio Auto Emoji Title
 * Studio-side companion of native 9D1a Auto Emoji Title. It owns the Title
 * Palette UI in Studio while writing the same native title/interface records.
 */
(() => {
  "use strict";

  const W = window;
  if (!W.H2O) W.H2O = {};
  if (W.H2O.StudioAutoEmojiTitle?.version) return;

  const NS_DISK = "h2o:prm:cgx:tmjttl";
  const KEY_PICKER_GROUPING = `${NS_DISK}:state:picker-grouping:v1`;
  const CHAT_TITLE_STATE_KEY_PREFIX = "h2o:prm:cgx:library:chat-title:state:v1:";
  const INTERFACE_META_KEY_PREFIX = "h2o:prm:cgx:library:interface-meta:v1:";
  const LIBRARY_SYNC_BROADCAST_KEY = "h2o:library:cross-surface:broadcast:v1";
  const HEAT_OVERRIDE_KEY_PREFIX = "ho:chat-heat-override:";
  const ROW_TINT_KEY_PREFIX = "ho:chat-row-idx:";

  const COLORS = Object.freeze([
    Object.freeze({ name: "gold", value: "rgba(212,175,55,1)" }),
    Object.freeze({ name: "red", value: "rgba(179,58,58,1)" }),
    Object.freeze({ name: "blue", value: "rgba(70,100,200,1)" }),
    Object.freeze({ name: "green", value: "rgba(60,150,90,1)" }),
  ]);

  let pickerEl = null;

  const emojiList = (line) => Object.freeze(String(line || "").trim().split(/\s+/).filter(Boolean));
  const emojiGroup = (label, line) => Object.freeze({ label, emojis: emojiList(line) });

  const OS_EMOJI_GROUPS = Object.freeze([
    emojiGroup("Smileys & Emotion", `
      😀 😃 😄 😁 😆 😅 😂 🤣 🥲 🥹 ☺️ 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚
      😋 😛 😝 😜 🤪 🤨 🧐 🤓 😎 🥸 🤩 🥳 😏 😒 😞 😔 😟 😕 🙁 ☹️
      😣 😖 😫 😩 🥺 😢 😭 😮‍💨 😤 😠 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🫣
      🤗 🫡 🤔 🫢 🤭 🤫 🤥 😶 😶‍🌫️ 😐 😑 😬 🫨 🫠 🙄 😯 😦 😧 😮 😲 🥱
      😴 🤤 😪 😵 😵‍💫 🫥 🤐 🥴 🤢 🤮 🤧 😷 🤒 🤕 🤑 🤠 😈 👿 👹 👺 🤡
      👻 💀 ☠️ 👽 👾 🤖 🎃 💌 💘 💝 💖 💗 💓 💞 💕 💟 ❣️ 💔 ❤️‍🔥 ❤️‍🩹 ❤️
      🩷 🧡 💛 💚 💙 🩵 💜 🤎 🖤 🩶 🤍 💋 💯 💢 💥 💫 💦 💨 💬 🗨️ 🗯️ 💭 💤
    `),
    emojiGroup("People & Body", `
      👋 🤚 🖐️ ✋ 🖖 👌 🤌 🤏 ✌️ 🤞 🫰 🤟 🤘 🤙 👈 👉 👆 🖕 👇 ☝️ 🫵
      👍 👎 ✊ 👊 🤛 🤜 👏 🙌 🫶 👐 🤲 🤝 🙏 ✍️ 💅 🤳 💪 🧠 👀 👁️ 👄
      👶 🧒 👦 👧 🧑 👨 👩 🧓 👴 👵 🙋 🙇 🤦 🤷 🧑‍⚕️ 👨‍⚕️ 👩‍⚕️ 🧑‍🎓
      👨‍🎓 👩‍🎓 🧑‍🏫 👨‍🏫 👩‍🏫 🧑‍⚖️ 👨‍⚖️ 👩‍⚖️ 🧑‍💻 👨‍💻 👩‍💻 🧑‍🔬
      👨‍🔬 👩‍🔬 🧑‍🎨 👨‍🎨 👩‍🎨 🧑‍🚀 👨‍🚀 👩‍🚀 👮 🕵️ 🥷 👷 🫅 🤴 👸
    `),
    emojiGroup("Animals & Nature", `
      🐵 🐶 🐺 🦊 🐱 🦁 🐯 🐴 🦄 🐮 🐷 🐭 🐹 🐰 🐻 🐼 🐨 🐸 🐢 🐍
      🐲 🐉 🦕 🦖 🐳 🐬 🐟 🐠 🐙 🦋 🐛 🐝 🐞 🕷️ 🦂 💐 🌸 🪷 🌹 🌺 🌻
      🌼 🌷 🌱 🪴 🌲 🌳 🌴 🌵 🍀 🍁 🍂 🍃 🌍 🌎 🌏 🪐 🌙 ☀️ ⭐ 🌟 🌌
      ☁️ ⛈️ 🌧️ 🌨️ 🌪️ 🌈 ⚡ ❄️ 🔥 💧 🌊
    `),
    emojiGroup("Food & Drink", `
      🍇 🍉 🍊 🍋 🍌 🍍 🥭 🍎 🍏 🍐 🍑 🍒 🍓 🫐 🥝 🍅 🫒 🥥 🥑 🍆 🥔
      🥕 🌽 🌶️ 🫑 🥒 🥬 🥦 🧄 🧅 🍞 🥐 🥯 🧀 🍖 🍗 🥩 🥓 🍔 🍟 🍕 🌭
      🥪 🌮 🌯 🥙 🥚 🍳 🥘 🍲 🥗 🍱 🍚 🍛 🍜 🍝 🍣 🍤 🍰 🧁 🍫 ☕ 🫖
      🍵 🍷 🍺 🥂 🥤 🧋 🍽️ 🍴 🥄
    `),
    emojiGroup("Activities", `
      🎃 🎄 🎆 ✨ 🎈 🎉 🎊 🎁 🎗️ 🎟️ 🏆 🥇 ⚽ ⚾ 🏀 🏈 🎾 🏏 🏒 🏓
      🥊 🥋 🎯 🪀 🎮 🕹️ 🎲 🧩 🧸 🎭 🖼️ 🎨 🧵 🧶 👓 🕶️ 🎒 👑 🎩 🎓
      🔔 🎼 🎵 🎶 🎙️ 🎤 🎧 🎷 🎸 🎹 🎺 🎻 🥁
    `),
    emojiGroup("Travel & Places", `
      🚗 🚕 🚙 🚌 🚓 🚑 🚒 🚐 🛻 🚚 🏍️ 🚲 🛴 🚏 🛣️ ⛽ 🚨 🚥 🚦 🛑
      ⚓ ⛵ 🚤 🚢 ✈️ 🛫 🛬 🚁 🚀 🛸 🧳 ⏰ ⏱️ ⌚ 🕰️ 🗺️ 🧭 🏔️ 🌋 🏕️
      🏖️ 🏜️ 🏝️ 🏟️ 🏛️ 🏗️ 🧱 🏠 🏢 🏥 🏦 🏨 🏫 🏭 🏰 🗽 ⛪ 🕌 🕍
    `),
    emojiGroup("Objects", `
      📱 ☎️ 🔋 🔌 💻 🖥️ 🖨️ ⌨️ 🖱️ 💽 💾 💿 🧮 🎥 🎬 📺 📷 📸 🔍 🔎
      💡 🔦 📔 📕 📖 📗 📘 📙 📚 📓 📒 📃 📜 📄 📰 📑 🔖 🏷️ 💰 💳 🧾
      ✉️ 📧 📨 📩 📤 📥 📦 📫 ✏️ ✒️ 🖋️ 🖊️ 🖌️ 🖍️ 📝 💼 📁 📂 🗂️ 📅
      📆 🗓️ 📈 📉 📊 📋 📌 📍 📎 📏 📐 ✂️ 🗃️ 🗄️ 🗑️ 🔒 🔓 🔑 🔨 🛠️
      🔧 🔩 ⚙️ ⚖️ 🔗 🧰 🧲 🧪 🧬 🔬 🔭 📡 💉 💊 🩺 🛒 🪪
    `),
    emojiGroup("Symbols", `
      ⚠️ 🚫 ⬆️ ↗️ ➡️ ↘️ ⬇️ ↙️ ⬅️ ↖️ ↕️ ↔️ 🔃 🔄 🔙 🔚 🔛 🔜 🔝
      ⚛️ ✡️ ☯️ ✝️ ☪️ ☮️ ♈ ♉ ♊ ♋ ♌ ♍ ♎ ♏ ♐ ♑ ♒ ♓ ▶️ ⏩ ⏭️
      ⏯️ ◀️ ⏪ ⏮️ ⏸️ ⏹️ ⏺️ 🔅 🔆 📶 ♀️ ♂️ ✖️ ➕ ➖ ➗ 🟰 ♾️ ❓ ❗
      💲 ⚕️ ♻️ ✅ ☑️ ✔️ ❌ ❎ ✳️ ©️ ®️ ™️ ℹ️ 🆕 🆗 🆘 🆙 🔴 🟠 🟡
      🟢 🔵 🟣 🟤 ⚫ ⚪ 🟥 🟧 🟨 🟩 🟦 🟪 🟫 ⬛ ⬜ 🔶 🔷 🔺 🔻
    `),
    emojiGroup("Flags", `
      🏁 🚩 🎌 🏴 🏳️ 🏳️‍🌈 🏳️‍⚧️ 🏴‍☠️ 🇦🇹 🇩🇪 🇪🇺 🇬🇧 🇺🇸 🇨🇦 🇨🇭
      🇳🇱 🇸🇪 🇳🇴 🇫🇮 🇯🇵 🇵🇸 🇦🇪 🇸🇦 🇹🇷 🇫🇷 🇪🇸 🇮🇹 🇵🇹 🇧🇷 🇲🇽
    `),
  ]);

  const TITLE_EMOJI_POOL = emojiList(`
    ⭐ ✨ ⚡ 🔥 💬 ✅ ❗ ⚠️ 🔁 🔒 🔓 📌 📍 🧭 🗺️ 🧩 🧱 📦 📤 💾 🔋
    📁 📂 🗂️ 🗃️ 🗄️ 📝 📄 📑 📜 🧾 📚 📖 📓 📒 📕 📗 📘 📙 📰 🔖 📎
    💻 🖥️ ⌨️ 🖱️ 🧠 🧪 🧬 🔬 🔭 📐 📏 🧮 ⚙️ 🛠️ 🔧 🔩 🧰 🪛 🪚 🔌 💡
    🚀 🛰️ 🛸 ✈️ 🌌 🌍 🌙 ☄️ ⏰ ⏱️ 🕰️ 📅 📆 🗓️ 💊 🩺 💉 ❤️ 🫀 🫁
    💪 🏋️ 🏃 🧘 😴 🍏 🍎 🍋 🥗 🍕 🍜 ☕ 🗨️ 🗣️ 📣 ✉️ 📧 📮 🎨 🖌️
    🖼️ ✏️ 🖊️ 📷 🎬 🎧 🎤 😀 😅 😂 😊 😉 😍 🥳 😎 🤓 🧐 🤔 🤯 😭 🤖
    👨‍💻 👩‍💻 👨‍🎓 👩‍🎓 👨‍🏫 👩‍🏫 👨‍🔬 👩‍🔬 👨‍⚕️ 👩‍⚕️ 👨‍⚖️ 👩‍⚖️
    👨‍🚀 👩‍🚀 ⚖️ 🏛️ 🏫 🏢 🏗️ 🔶 🔷 🔺 🔻 ⬆️ ⬇️ ⬅️ ➡️ 🇵🇸 🇩🇪 🇦🇹 🇪🇺 🇺🇸
  `);

  const INTERNAL_EMOJI_GROUPS = Object.freeze([
    Object.freeze({ label: "Signals", emojis: TITLE_EMOJI_POOL.slice(0, 21) }),
    Object.freeze({ label: "Library", emojis: TITLE_EMOJI_POOL.slice(21, 43) }),
    Object.freeze({ label: "Build", emojis: TITLE_EMOJI_POOL.slice(43, 65) }),
    Object.freeze({ label: "Health", emojis: TITLE_EMOJI_POOL.slice(77, 90) }),
    Object.freeze({ label: "Messages", emojis: TITLE_EMOJI_POOL.slice(98, 108) }),
    Object.freeze({ label: "Creative", emojis: TITLE_EMOJI_POOL.slice(108, 118) }),
    Object.freeze({ label: "Faces", emojis: TITLE_EMOJI_POOL.slice(118, 134) }),
    Object.freeze({ label: "Roles", emojis: TITLE_EMOJI_POOL.slice(134, 148) }),
    Object.freeze({ label: "Civic", emojis: TITLE_EMOJI_POOL.slice(148, 153) }),
    Object.freeze({ label: "Direction", emojis: TITLE_EMOJI_POOL.slice(153, 165) }),
    Object.freeze({ label: "Flags", emojis: TITLE_EMOJI_POOL.slice(165) }),
  ]).filter((group) => group.emojis.length);

  const SEARCH_SECTIONS = Object.freeze([
    Object.freeze({ label: "Smileys & Emotion", keys: ["smile", "face", "emotion", "heart", "love", "happy", "sad"], emojis: OS_EMOJI_GROUPS[0].emojis }),
    Object.freeze({ label: "People & Body", keys: ["people", "person", "body", "hand", "gesture", "role"], emojis: OS_EMOJI_GROUPS[1].emojis }),
    Object.freeze({ label: "Animals & Nature", keys: ["animal", "nature", "plant", "weather", "earth"], emojis: OS_EMOJI_GROUPS[2].emojis }),
    Object.freeze({ label: "Food & Drink", keys: ["food", "drink", "coffee", "meal", "fruit"], emojis: OS_EMOJI_GROUPS[3].emojis }),
    Object.freeze({ label: "Activities", keys: ["activity", "sport", "game", "music", "art", "party"], emojis: OS_EMOJI_GROUPS[4].emojis }),
    Object.freeze({ label: "Travel & Places", keys: ["travel", "place", "space", "time", "car", "plane", "city"], emojis: OS_EMOJI_GROUPS[5].emojis }),
    Object.freeze({ label: "Objects", keys: ["object", "work", "tool", "code", "book", "health", "medical", "money"], emojis: OS_EMOJI_GROUPS[6].emojis }),
    Object.freeze({ label: "Symbols", keys: ["symbol", "arrow", "shape", "warning", "status"], emojis: OS_EMOJI_GROUPS[7].emojis }),
    Object.freeze({ label: "Flags", keys: ["flag", "country", "nation"], emojis: OS_EMOJI_GROUPS[8].emojis }),
    Object.freeze({ label: "Legal", keys: ["law", "legal", "court", "civic"], emojis: emojiList("⚖️ 🏛️ 📜 🧾 🗂️ 📝 ❗ ⚠️") }),
  ]);

  const PICKER_EMOJI_POOL = Object.freeze(Array.from(new Set(
    OS_EMOJI_GROUPS.flatMap((group) => group.emojis || []).concat(TITLE_EMOJI_POOL)
  )));

  function stopEvent(ev){
    ev?.preventDefault?.();
    ev?.stopPropagation?.();
    ev?.stopImmediatePropagation?.();
  }

  function getPickerGrouping(){
    try {
      const key = String(localStorage.getItem(KEY_PICKER_GROUPING) || "os").trim().toLowerCase();
      return key === "internal" ? "internal" : "os";
    } catch {
      return "os";
    }
  }

  function getActiveSections(){
    return getPickerGrouping() === "internal" ? INTERNAL_EMOJI_GROUPS : OS_EMOJI_GROUPS;
  }

  function searchSections(query){
    const q = String(query || "").trim().toLowerCase();
    if (!q) return getActiveSections();

    const sections = [];
    SEARCH_SECTIONS.forEach((section) => {
      const keys = Array.isArray(section.keys) ? section.keys : [];
      if (keys.some((key) => key && (q.includes(key) || String(key).includes(q)))) {
        sections.push({ label: section.label, emojis: section.emojis });
      }
    });
    if (sections.length) return sections;

    getActiveSections().forEach((section) => {
      const label = String(section.label || "").toLowerCase();
      const emojis = (section.emojis || []).filter((emoji) => String(emoji || "").includes(q));
      if (emojis.length || (label && (label.includes(q) || q.includes(label)))) {
        sections.push({ label: section.label, emojis: emojis.length ? emojis : section.emojis });
      }
    });
    return sections.length ? sections : [{ label: "Results", emojis: PICKER_EMOJI_POOL.slice(0, 144) }];
  }

  function normalizeHeatLevel(level){
    const key = String(level || "").trim().toLowerCase();
    return key === "hot" || key === "warm" || key === "off" || key === "auto" ? key : "auto";
  }

  function toRowTintIndex(value, fallback = -1){
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) && n >= 0 && n < COLORS.length ? n : fallback;
  }

  function splitTitleEmoji(raw){
    const value = String(raw || "").trim();
    if (!value) return { emoji: "", baseTitle: "" };
    let first = Array.from(value)[0] || "";
    try {
      const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
      first = seg.segment(value)[Symbol.iterator]().next().value?.segment || first;
    } catch {}
    if (!/\p{Extended_Pictographic}|\p{Emoji_Presentation}/u.test(first)) {
      return { emoji: "", baseTitle: value };
    }
    return { emoji: first, baseTitle: value.slice(first.length).trim() };
  }

  function displayTitleWithEmoji(baseTitle, emoji){
    const base = String(baseTitle || "").trim();
    const icon = String(emoji || "").trim();
    return [icon, base].filter(Boolean).join(" ").trim() || base || icon;
  }

  function getLibraryStore(){
    try { return W.H2O?.Library?.Store || null; } catch { return null; }
  }

  async function readSharedRecord(key){
    const k = String(key || "");
    if (!k) return {};
    try {
      const store = getLibraryStore();
      if (store && typeof store.get === "function") {
        const stored = await store.get(k);
        if (stored && typeof stored === "object" && !Array.isArray(stored)) return stored;
      }
    } catch {}
    try {
      const legacy = JSON.parse(localStorage.getItem(k) || "{}");
      return legacy && typeof legacy === "object" && !Array.isArray(legacy) ? legacy : {};
    } catch { return {}; }
  }

  async function writeSharedRecord(key, value){
    const k = String(key || "");
    if (!k) return false;
    const store = getLibraryStore();
    if (!store || typeof store.set !== "function") throw new Error("Library Store unavailable");
    const record = value && typeof value === "object" ? value : {};
    await store.set(k, record);
    return true;
  }

  function broadcast(reason, payload){
    const body = {
      ts: Date.now(),
      surface: "studio",
      reason: String(reason || "studio-auto-emoji-title"),
      payload: payload && typeof payload === "object" ? payload : null,
    };
    let routed = false;
    try {
      const sync = W.H2O?.Library?.Sync;
      if (sync && typeof sync.broadcast === "function") {
        sync.broadcast(body.reason, body.payload);
        routed = true;
      }
    } catch {}
    if (!routed) {
      try {
        const emitRaw = W.H2O?.Studio?.platform?.broadcast?.emitRaw;
        if (typeof emitRaw === "function") {
          Promise.resolve(emitRaw(LIBRARY_SYNC_BROADCAST_KEY, body)).catch(() => {});
        }
      } catch {}
    }
    try {
      W.dispatchEvent(new CustomEvent("evt:h2o:library:cross-surface-sync", {
        detail: { reasons: [body.reason], t: body.ts, surface: "studio" },
      }));
    } catch {}
  }

  async function persistTitleState(row, emoji){
    const chatId = String(row?.chatId || "").trim();
    if (!chatId) return null;
    const split = splitTitleEmoji(row?.titleState?.baseTitle || row?.title || "");
    const baseTitle = String(row?.titleState?.baseTitle || split.baseTitle || row?.title || chatId).trim();
    const nextEmoji = String(emoji || "").trim();
    const now = Date.now();
    const payload = {
      version: "1.0.0",
      chatId,
      baseTitle,
      source: "studio-title-palette",
      priority: 100,
      confidence: 1,
      emoji: nextEmoji,
      emojiSource: "user-picker-native-rename",
      emojiPriority: 100,
      emojiConfidence: 1,
      updatedAt: now,
      emojiUpdatedAt: now,
    };
    await writeSharedRecord(`${CHAT_TITLE_STATE_KEY_PREFIX}${chatId}`, payload);
    const titleState = { ...payload, displayTitle: displayTitleWithEmoji(baseTitle, nextEmoji) };
    broadcast("studio-title-palette", { chatId, titleState });
    return titleState;
  }

  async function persistInterfaceMeta(chatId, patch, reason){
    const id = String(chatId || "").trim();
    if (!id) return false;
    const key = `${INTERFACE_META_KEY_PREFIX}${id}`;
    const prev = await readSharedRecord(key);
    const meta = {
      ...(prev && typeof prev === "object" ? prev : {}),
      ...(patch && typeof patch === "object" ? patch : {}),
      chatId: id,
      updatedAt: Date.now(),
    };
    await writeSharedRecord(key, meta);
    broadcast(reason || "studio-interface-meta", { chatId: id, meta });
    return true;
  }

  async function defaultApplyMetaChoice(target, row){
    const chatId = String(row?.chatId || "").trim();
    if (!chatId || !target) return;
    const mode = String(target.dataset.mode || "");
    if (mode === "heat") {
      const level = normalizeHeatLevel(target.dataset.level || "auto");
      const key = `${HEAT_OVERRIDE_KEY_PREFIX}${chatId}`;
      const store = getLibraryStore();
      if (!store || typeof store.set !== "function" || typeof store.del !== "function") throw new Error("Library Store unavailable");
      if (level === "auto") await store.del(key);
      else await store.set(key, level);
      await persistInterfaceMeta(chatId, { heatOverride: level }, "studio-title-palette-heat");
      row.heatOverride = level;
      row.heatLevel = level;
    } else if (mode === "row") {
      const idx = Number.parseInt(target.dataset.idx || "-1", 10);
      const current = toRowTintIndex(row.rowTint, -1);
      const next = current === idx ? -1 : toRowTintIndex(idx, -1);
      const key = `${ROW_TINT_KEY_PREFIX}${chatId}`;
      const store = getLibraryStore();
      if (!store || typeof store.set !== "function" || typeof store.del !== "function") throw new Error("Library Store unavailable");
      if (next < 0) await store.del(key);
      else await store.set(key, String(next));
      await persistInterfaceMeta(chatId, { rowTint: next }, "studio-title-palette-row-tint");
      row.rowTint = next;
    }
  }

  function refreshMetaPalette(palette, row){
    if (!palette || !row) return;
    const heat = normalizeHeatLevel(row.heatOverride);
    const rowTint = toRowTintIndex(row.rowTint, -1);
    palette.querySelectorAll(".ho-swatch.heat").forEach((sw) => {
      sw.classList.toggle("ho-meta-selected", sw.dataset.level === heat);
    });
    palette.querySelectorAll(".ho-swatch.row").forEach((sw) => {
      sw.classList.toggle("ho-meta-selected", Number(sw.dataset.idx) === rowTint);
    });
  }

  function buildMetaPalette(row, callbacks){
    const palette = document.createElement("div");
    palette.className = "ho-palette ho-emoji-meta-palette show";
    palette.dataset.chatid = row.chatId || "";

    const heatRow = document.createElement("div");
    heatRow.className = "ho-palette-row ho-emoji-heat-row";
    [["auto", "A"], ["hot", "H"], ["warm", "W"], ["off", "O"]].forEach(([level, label]) => {
      const sw = document.createElement("button");
      sw.type = "button";
      sw.className = "ho-swatch heat";
      sw.textContent = label;
      sw.title = `Heat: ${level}`;
      sw.setAttribute("aria-label", `Heat: ${level}`);
      sw.dataset.mode = "heat";
      sw.dataset.level = level;
      heatRow.appendChild(sw);
    });

    const divider = document.createElement("span");
    divider.className = "ho-emoji-meta-divider";
    divider.setAttribute("aria-hidden", "true");

    const rowRow = document.createElement("div");
    rowRow.className = "ho-palette-row ho-emoji-row-tint-row";
    COLORS.forEach((color, idx) => {
      const sw = document.createElement("button");
      sw.type = "button";
      sw.className = "ho-swatch row";
      sw.style.backgroundColor = String(color.value || "").replace(/,1\)/, ",0.5)");
      sw.title = `Row: ${color.name}`;
      sw.setAttribute("aria-label", `Row: ${color.name}`);
      sw.dataset.mode = "row";
      sw.dataset.idx = String(idx);
      rowRow.appendChild(sw);
    });

    let choosingMeta = false;
    const choose = (target, ev) => {
      if (!target) return;
      stopEvent(ev);
      if (choosingMeta) return;
      choosingMeta = true;
      if (typeof callbacks?.applyMetaChoice === "function") {
        callbacks.applyMetaChoice(target, palette);
      } else {
        defaultApplyMetaChoice(target, row).then(() => refreshMetaPalette(palette, row)).catch(console.warn);
      }
      refreshMetaPalette(palette, row);
      W.setTimeout(() => { choosingMeta = false; }, 120);
    };

    palette.addEventListener("pointerdown", (ev) => {
      choose(ev.target?.closest?.(".ho-swatch"), ev);
    }, true);
    palette.addEventListener("mousedown", (ev) => choose(ev.target?.closest?.(".ho-swatch"), ev), true);
    palette.addEventListener("click", (ev) => choose(ev.target?.closest?.(".ho-swatch"), ev), true);
    palette.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      choose(ev.target?.closest?.(".ho-swatch"), ev);
    }, true);

    palette.appendChild(heatRow);
    palette.appendChild(divider);
    palette.appendChild(rowRow);
    refreshMetaPalette(palette, row);
    return palette;
  }

  function renderSections(grid, sections, selectedEmoji, selectEmoji){
    grid.innerHTML = "";
    const seen = new Set();
    for (const section of sections){
      const list = Array.from(new Set(section.emojis || [])).filter((emoji) => emoji && !seen.has(emoji));
      if (!list.length) continue;

      const wrap = document.createElement("section");
      wrap.className = "ho-emoji-section";

      const label = document.createElement("div");
      label.className = "ho-emoji-section-title";
      label.textContent = section.label || "Icons";

      const cells = document.createElement("div");
      cells.className = "ho-emoji-section-grid";

      list.forEach((emoji) => {
        seen.add(emoji);
        const button = document.createElement("button");
        button.type = "button";
        button.className = "ho-emoji-btn";
        if (selectedEmoji && emoji === selectedEmoji) button.classList.add("ho-emoji-selected");
        button.textContent = emoji;
        button.setAttribute("aria-label", `Use ${emoji}`);
        button.addEventListener("pointerdown", (ev) => selectEmoji(emoji, ev), true);
        button.addEventListener("mousedown", (ev) => selectEmoji(emoji, ev), true);
        button.addEventListener("click", (ev) => selectEmoji(emoji, ev), true);
        button.addEventListener("keydown", (ev) => {
          if (ev.key !== "Enter" && ev.key !== " ") return;
          selectEmoji(emoji, ev);
        }, true);
        cells.appendChild(button);
      });

      wrap.appendChild(label);
      wrap.appendChild(cells);
      grid.appendChild(wrap);
    }
  }

  function closePalette(){
    if (!pickerEl) return;
    const owner = pickerEl;
    pickerEl = null;
    owner.remove();
    document.querySelectorAll(".wbRowTools [aria-expanded='true']").forEach((node) => {
      node.setAttribute("aria-expanded", "false");
    });
  }

  function openPalette(options = {}){
    const row = options.row || {};
    const article = options.article || null;
    const anchor = options.anchor || null;
    const callbacks = options.callbacks || {};
    if (!row.chatId) return null;

    closePalette();

    const gutter = 12;
    const pickerWidth = Math.min(398, Math.max(292, W.innerWidth - (gutter * 2)));
    const pickerHeight = Math.min(462, Math.max(300, W.innerHeight - (gutter * 2)));
    const rect = anchor?.getBoundingClientRect?.() || article?.getBoundingClientRect?.() || { left: gutter, right: gutter + pickerWidth, bottom: gutter };
    const left = Math.max(gutter, Math.min(rect.right - pickerWidth, W.innerWidth - pickerWidth - gutter));
    const top = Math.max(gutter, Math.min(rect.bottom + 8, W.innerHeight - pickerHeight - gutter));
    const split = splitTitleEmoji(row?.titleState?.displayTitle || row?.title || "");
    const selectedEmoji = String(row?.titleState?.emoji || split.emoji || "").trim();

    const picker = document.createElement("div");
    pickerEl = picker;
    picker.className = "ho-emoji-picker";
    picker.setAttribute("data-cgxui-owner", "auto-title-palette");
    picker.setAttribute("data-h2o-glass", "panel");
    picker.setAttribute("data-h2o-skin-surface", "sand-glass");
    picker.style.setProperty("--ho-picker-w", `${pickerWidth}px`);
    picker.style.setProperty("--ho-picker-max-h", `${pickerHeight}px`);
    picker.style.left = `${left}px`;
    picker.style.top = `${top}px`;

    const topbar = document.createElement("div");
    topbar.className = "ho-emoji-picker-top";

    const title = document.createElement("div");
    title.className = "ho-emoji-picker-title";
    const icon = document.createElement("span");
    icon.className = "ho-title-panel-icon";
    icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 7.5h8.75a3.25 3.25 0 0 1 0 6.5H9.2"/><path d="M6.5 7.5 4 5m2.5 2.5L4 10"/><path d="M17.5 16.5 20 19m-2.5-2.5L20 14"/><path d="M8 14.25h5.6"/></svg>';
    icon.setAttribute("aria-hidden", "true");
    const titleText = document.createElement("span");
    titleText.textContent = "Title Palette";
    title.appendChild(icon);
    title.appendChild(titleText);

    const close = document.createElement("button");
    close.type = "button";
    close.className = "ho-emoji-close";
    close.textContent = "×";
    close.setAttribute("aria-label", "Close emoji picker");
    close.addEventListener("pointerdown", (ev) => {
      stopEvent(ev);
      closePalette();
    }, true);

    topbar.appendChild(title);
    topbar.appendChild(close);

    const input = document.createElement("input");
    input.placeholder = "Search emoji, symbols, food, travel, flags";
    input.setAttribute("aria-label", "Search emoji");

    const search = document.createElement("div");
    search.className = "ho-emoji-search";
    search.appendChild(input);

    const grid = document.createElement("div");
    grid.className = "ho-emoji-grid";

    let selectingEmoji = false;
    const selectEmoji = (emoji, ev) => {
      stopEvent(ev);
      if (selectingEmoji) return;
      selectingEmoji = true;
      const persist = typeof callbacks.persistTitleState === "function"
        ? callbacks.persistTitleState
        : persistTitleState;
      Promise.resolve(persist(row, emoji)).then((titleState) => {
        if (!titleState) return;
        if (typeof callbacks.applyTitleState === "function") {
          callbacks.applyTitleState(titleState);
        }
        closePalette();
      }).catch((error) => {
        selectingEmoji = false;
        console.warn(error);
      });
    };

    renderSections(grid, getActiveSections(), selectedEmoji, selectEmoji);
    input.addEventListener("input", () => {
      renderSections(grid, searchSections(input.value), selectedEmoji, selectEmoji);
    });

    picker.addEventListener("pointerdown", (ev) => ev.stopPropagation(), true);
    picker.addEventListener("click", (ev) => ev.stopPropagation(), true);
    picker.appendChild(topbar);
    picker.appendChild(search);
    picker.appendChild(buildMetaPalette(row, callbacks));
    picker.appendChild(grid);
    document.body.appendChild(picker);
    anchor?.setAttribute("aria-expanded", "true");
    requestAnimationFrame(() => input.focus());
    return picker;
  }

  W.H2O.StudioAutoEmojiTitle = {
    version: "1.0.0",
    openPalette,
    closePalette,
    persistTitleState,
    persistInterfaceMeta,
    keys: Object.freeze({
      chatTitleStatePrefix: CHAT_TITLE_STATE_KEY_PREFIX,
      interfaceMetaPrefix: INTERFACE_META_KEY_PREFIX,
      pickerGrouping: KEY_PICKER_GROUPING,
      heatOverridePrefix: HEAT_OVERRIDE_KEY_PREFIX,
      rowTintPrefix: ROW_TINT_KEY_PREFIX,
    }),
  };
})();
