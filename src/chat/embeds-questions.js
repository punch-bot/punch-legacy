import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  CheckboxGroupBuilder,
  LabelBuilder,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  SeparatorBuilder,
  ThumbnailBuilder,
  MessageFlags,
} from "discord.js";
import { registry } from "../core/registry.js";
import { escapeStrayMarkdown, truncateMarkdown } from "../discord-markdown.js";

const EMBED_RE = /<embed\s*>([\s\S]*?)<\/embed>/gi;
const QUESTION_RE = /<question\b([^>]*)>([\s\S]*?)<\/question>/gi;
const QUESTION_OPTION_RE = /^\s*(?:[-*•]|\d+[.)])\s+(.+?)\s*$/;

function embedMarkdown(text, limit) {
  return truncateMarkdown(escapeStrayMarkdown(String(text)), limit);
}

function buildEmbedFromJson(j) {
  if (!j || typeof j !== "object") return null;
  const e = new EmbedBuilder();
  if (j.title) e.setTitle(String(j.title).slice(0, 256));
  if (j.description) e.setDescription(embedMarkdown(j.description, 4096));
  if (j.url) e.setURL(String(j.url));
  if (j.color !== undefined) {
    const c = Number(j.color);
    if (!Number.isNaN(c)) e.setColor(c);
  }
  if (j.author && typeof j.author === "object") {
    const a = { name: String(j.author.name || "").slice(0, 256) };
    if (j.author.url) a.url = String(j.author.url);
    if (j.author.icon_url) a.iconURL = String(j.author.icon_url);
    if (a.name) e.setAuthor(a);
  }
  if (j.thumbnail && j.thumbnail.url) e.setThumbnail(String(j.thumbnail.url));
  if (j.image && j.image.url) e.setImage(String(j.image.url));
  if (j.footer && typeof j.footer === "object") {
    const f = { text: String(j.footer.text || "").slice(0, 2048) };
    if (j.footer.icon_url) f.iconURL = String(j.footer.icon_url);
    if (f.text) e.setFooter(f);
  }
  if (Array.isArray(j.fields)) {
    for (const f of j.fields.slice(0, 25)) {
      if (f && f.name != null && f.value != null) {
        e.addFields({ name: embedMarkdown(f.name, 256), value: embedMarkdown(f.value, 1024), inline: !!f.inline });
      }
    }
  }
  if (j.timestamp) {
    const ts = new Date(j.timestamp);
    if (!Number.isNaN(ts.getTime())) e.setTimestamp(ts);
  }
  return e;
}

export function extractEmbeds(textIn) {
  const embeds = [];
  const errors = [];
  const text = String(textIn || "").replace(EMBED_RE, (_m, body) => {
    try {
      const json = JSON.parse(body.trim());
      const e = buildEmbedFromJson(json);
      if (e) embeds.push(e);
    } catch (err) {
      errors.push(`embed JSON error: ${err.message}`);
    }
    return "";
  }).trim();
  return { clean: text, embeds, errors };
}

function parseQuestionAttrs(attrs) {
  const q = { title: null, description: null, multi: false, style: null, input: [] };
  const t = attrs.match(/title="([^"]*)"/i);
  if (t) q.title = t[1];
  const d = attrs.match(/description="([^"]*)"/i);
  if (d) q.description = d[1];
  if (/\bmulti\b/i.test(attrs.replace(/="[^"]*"/g, ""))) q.multi = true;
  const s = attrs.match(/style="([^"]*)"/i);
  if (s) q.style = s[1].toLowerCase();
  const inp = attrs.match(/input="([^"]*)"/i);
  if (inp) q.input = inp[1].split(";").map((x) => x.trim()).filter(Boolean).slice(0, 5);
  return q;
}

function parseQuestionOptions(body) {
  const opts = [];
  for (const line of String(body).split(/\n/)) {
    const m = line.match(QUESTION_OPTION_RE);
    if (m) opts.push(m[1].trim());
  }
  return opts;
}

export function extractQuestions(textIn) {
  const questions = [];
  const text = String(textIn || "").replace(QUESTION_RE, (_m, attrs, body) => {
    const q = parseQuestionAttrs(attrs);
    q.options = parseQuestionOptions(body);
    if (q.options.length === 0 && q.input.length === 0) return "";
    questions.push(q);
    return "";
  }).trim();
  return { clean: text, questions };
}

function buildQuestionComponents(q, messageId) {
  const opts = q.options.slice(0, 25);
  if (q.style === "checkbox") {
    const rows = [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`qchk:${messageId}`)
          .setLabel(("☑ " + (q.title || "Choose options")).slice(0, 80))
          .setStyle(ButtonStyle.Primary),
      ),
    ];
    if (q.input && q.input.length) {
      rows.push(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`qans:${messageId}`)
            .setLabel("✏️ Other…")
            .setStyle(ButtonStyle.Secondary),
        ),
      );
    }
    return rows;
  }
  const useSelect = opts.length > 5 || ((q.style === "select" || q.multi) && opts.length > 0);
  if (useSelect) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`qsel:${messageId}`)
      .setPlaceholder((q.title || "Choose an option").slice(0, 100))
      .addOptions(opts.map((o, i) => ({ label: o.slice(0, 100), value: `o${i}` })));
    if (q.multi) menu.setMinValues(1).setMaxValues(opts.length);
    return [new ActionRowBuilder().addComponents(menu)];
  }
  const rows = [];
  let row = new ActionRowBuilder();
  for (let i = 0; i < opts.length; i++) {
    if (row.components.length === 5) {
      rows.push(row);
      row = new ActionRowBuilder();
    }
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`qbtn:${messageId}:${i}`)
        .setLabel(opts[i].slice(0, 80))
        .setStyle(ButtonStyle.Primary),
    );
  }
  if (row.components.length) rows.push(row);
  if (q.input && q.input.length) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`qans:${messageId}`)
          .setLabel(opts.length > 0 ? "✏️ Other…" : "✏️ Answer")
          .setStyle(ButtonStyle.Secondary),
      ),
    );
  }
  return rows;
}

export function registerQuestionState(messageId, state) {
  registry.questionState.set(messageId, state);
  if (registry.questionState.size > 500) {
    const firstKey = registry.questionState.keys().next().value;
    if (firstKey) registry.questionState.delete(firstKey);
  }
}

export async function sendQuestion(channel, q, fromUserId) {
  const embed = new EmbedBuilder();
  if (q.title) embed.setTitle(q.title.slice(0, 256));
  if (q.description) embed.setDescription(embedMarkdown(q.description, 4096));
  embed.setColor(0x5865f2);
  const qmsg = await channel.send({
    embeds: [embed],
    allowedMentions: { parse: [] },
  }).catch(() => null);
  if (!qmsg) return;
  const components = buildQuestionComponents(q, qmsg.id);
  await qmsg.edit({ components }).catch(() => {});
  registerQuestionState(qmsg.id, {
    title: q.title,
    options: q.options.slice(0, 25),
    multi: !!q.multi,
    input: (q.input || []).slice(0, 5),
    fromUserId,
  });
}

// --- Components V2 -------------------------------------------------------
// The model emits <cv2 accent="#RRGGBB">{json spec}</cv2>. V2 messages render
// rich card layouts (text, sections, galleries, separators) with real
// interactive buttons inside — the thing classic embeds physically cannot do.
// Spec item shapes:
//   {"type":"text", "content":"..."}
//   {"type":"section", "text":"...", "thumbnail":{"url":"attachment://x.png","description":"..."}}
//   {"type":"gallery", "items":[{"url":"...","description":"..."}]}
//   {"type":"separator", "spacing":1|2, "divider":true|false}
//   {"type":"buttons", "title":"...", "options":["..."], "input":"Field;Another"}

const CV2_RE = /<cv2\b([^>]*)>([\s\S]*?)<\/cv2>/gi;
const HEX_COLOR_RE = /^#?([0-9a-f]{6})$/i;

// Answered V2 cards keep their content: re-render the non-interactive spec
// items plus a note TextDisplay. Exported for commands/questions.js.
export function buildV2AnsweredComponents(specItems, accent, note) {
  const { top, has } = v2SpecToComponents((specItems || []).filter((i) => i && i.type !== "buttons"), v2AccentToNumber(accent), [], true, null);
  if (has && top.length && note) {
    top[0].addTextDisplayComponents(new TextDisplayBuilder().setContent(String(note).slice(0, 4000)));
  }
  return top.length ? top : [new TextDisplayBuilder().setContent(String(note || "✅ answered"))];
}

// Inline-continuation: instead of spawning a fresh message for every cv2
// answer, agent chat can EDIT the original card with the next spec (channels
// render one evolving guide). Files fall back to the card's own attachments so
// galleries survive the edit.
export async function editV2(cardMessage, spec, fromUserId) {
  if (!spec || !Array.isArray(spec.items) || !spec.items.length) return false;
  let files = [];
  try {
    const atts = [...(cardMessage.attachments?.values?.() || [])];
    files = atts.map((a) => ({ attachment: a.url, name: a.name }));
  } catch {
    files = [];
  }
  const accent = v2AccentToNumber(spec.accent);
  const built = v2SpecToComponents(spec.items, accent, files, true, cardMessage.id);
  if (!built.has) return false;
  const editPayload = { components: built.top };
  const sendable = files.filter((f) => f.attachment && f.name);
  if (sendable.length) editPayload.files = sendable;
  await cardMessage.edit(editPayload);
  rememberV2Card(cardMessage.channelId || (cardMessage.channel && cardMessage.channel.id), fromUserId, cardMessage.id);
  const rows = built.rows || {};
  registerQuestionState(cardMessage.id, {
    title: rows.titles?.find(Boolean) || "Options",
    options: rows.options || [],
    multi: false,
    input: rows.input || [],
    fromUserId,
    v2: true,
    specItems: spec.items.filter((i) => i && i.type !== "buttons"),
    accent: spec.accent || "",
    inline: true,
  });
  return true;
}

function v2AccentToNumber(accent, fallback = 0x5865f2) {
  if (typeof accent !== "string") return fallback;
  const m = accent.match(HEX_COLOR_RE);
  return m ? parseInt(m[1], 16) : fallback;
}

// Salvage a spec whose JSON has trailing junk after a complete value (the model
// writes a balanced array and then a stray brace). Walk the string tracking
// depth + string state and return the prefix ending where depth hits zero.
function balancedJsonPrefix(raw) {
  const s = String(raw || "").trim();
  const start = s.search(/[[{]/);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") {
      depth--;
      if (depth === 0) {
        const prefix = s.slice(start, i + 1);
        return prefix.length < s.length ? prefix : null;
      }
    }
  }
  return null;
}

export function extractV2(textIn) {
  const v2 = [];
  const errors = [];
  const text = String(textIn || "").replace(CV2_RE, (_m, attrs, body) => {
    const accentMatch = attrs.match(/accent="([^"]*)"/i);
    let candidate = String(body || "").trim();
    let salvaged = false;
    try {
      try {
        JSON.parse(candidate);
      } catch (firstErr) {
        const prefix = balancedJsonPrefix(candidate);
        if (!prefix) throw firstErr;
        candidate = prefix;
        salvaged = true;
      }
      const json = JSON.parse(candidate);
      if (salvaged) errors.push("cv2 JSON repaired: trailing characters ignored");
      const items = Array.isArray(json) ? json : Array.isArray(json.components) ? json.components : null;
      if (!items || items.length === 0) return "";
      v2.push({ accent: String(accentMatch?.[1] || json.accent || ""), items });
    } catch (err) {
      errors.push(`cv2 JSON error: ${err.message}`);
    }
    return "";
  }).trim();
  return { clean: text, v2, errors: errors };
}

function resolveAttachmentUrl(url, files) {
  if (!url || !String(url).startsWith("attachment://")) return url || null;
  const name = String(url).slice("attachment://".length);
  const hit = (files || []).find((f) => f && f.name === name);
  return hit ? `attachment://${hit.name}` : null;
}

// Interactive button rows need the message id, which only exists after send:
// first pass renders layout without rows (interactive=false), then we edit the
// message with rows built against its own id (interactive=true, messageId set).
function v2SpecToComponents(items, accentNumber, files, interactive, messageId) {
  const top = [];
  const rows = []; // interactive rows are rendered after the container
  let has = false;
  const container = new ContainerBuilder().setAccentColor(accentNumber);
  for (const item of (items || []).slice(0, 38)) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "text" && item.content != null) {
      has = true;
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(String(item.content).slice(0, 4000)),
      );
    } else if (item.type === "section" && item.text != null) {
      has = true;
      const texts = (Array.isArray(item.text) ? item.text : [item.text])
        .map((t) => String(t).slice(0, 4000));
      const section = new SectionBuilder();
      section.addTextDisplayComponents(...texts.map((t) => new TextDisplayBuilder().setContent(t)));
      if (item.thumbnail && typeof item.thumbnail === "object") {
        const url = resolveAttachmentUrl(item.thumbnail.url, files);
        if (url) {
          const thumb = new ThumbnailBuilder().setURL(url);
          if (item.thumbnail.description) thumb.setDescription(String(item.thumbnail.description).slice(0, 1024));
          section.setThumbnailAccessory(thumb);
        }
      }
      container.addSectionComponents(section);
    } else if (item.type === "gallery" && Array.isArray(item.items)) {
      const itemsG = item.items.slice(0, 10)
        .map((g) => ({
          url: resolveAttachmentUrl(g && g.url, files),
          description: g && g.description ? String(g.description).slice(0, 1024) : undefined,
        }))
        .filter((g) => g.url);
      if (itemsG.length) {
        has = true;
        container.addMediaGalleryComponents(
          new MediaGalleryBuilder().addItems(
            ...itemsG.map((g) => {
              const b = new MediaGalleryItemBuilder().setURL(g.url);
              if (g.description) b.setDescription(g.description);
              return b;
            }),
          ),
        );
      }
    } else if (item.type === "separator") {
      has = true;
      const sep = new SeparatorBuilder();
      const spacing = Number(item.spacing);
      if (spacing === 1 || spacing === 2) sep.setSpacing(spacing);
      if (typeof item.divider === "boolean") sep.setDivider(item.divider);
      container.addSeparatorComponents(sep);
    } else if (item.type === "buttons" && Array.isArray(item.options)) {
      has = true;
      // options may be plain strings or {label, style} (primary/secondary/success/danger)
      const STYLE_NAMES = { primary: ButtonStyle.Primary, secondary: ButtonStyle.Secondary, success: ButtonStyle.Success, danger: ButtonStyle.Danger, link: ButtonStyle.Link };
      const options = item.options.map((o) =>
        typeof o === "object" && o !== null ? { label: String(o.label || o.text || "?"), style: STYLE_NAMES[String(o.style || "primary").toLowerCase()] ?? ButtonStyle.Primary } : { label: String(o), style: ButtonStyle.Primary },
      ).slice(0, 25);
      const input = item.input ? String(item.input).split(";").map((x) => x.trim()).filter(Boolean).slice(0, 5) : [];
      if (interactive && messageId) {
        const row = new ActionRowBuilder();
        options.slice(0, 5).forEach((o, i) => {
          const b = new ButtonBuilder()
            .setCustomId(`qbtn:${messageId}:${i}`)
            .setLabel(o.label.slice(0, 80))
            .setStyle(o.style);
          row.addComponents(b);
        });
        const hasOther = input.length > 0 || options.length > 5;
        if (hasOther) {
          row.addComponents(
            new ButtonBuilder()
              .setCustomId(`qans:${messageId}`)
              .setLabel("✏️ Other…")
              .setStyle(ButtonStyle.Secondary),
          );
        }
        // rows live INSIDE the container so the buttons render within the
        // card boundary (juniper's "WE NEED INLINE BUTTONS", 2026-11-08)
        container.addActionRowComponents(row);
      }
      // stashed on both passes; consumed by registerQuestionState after send
      rows.options = rows.options || [];
      rows.options.push(...options.map((o) => o.label));
      rows.input = rows.input || [];
      rows.input.push(...input);
      rows.titles = rows.titles || [];
      rows.titles.push(item.title || "");
    }
  }
  if (has) top.push(container);
  return { top, rows, has };
}

// Track the newest cv2 card so a follow-up spec can rewrite it in place even
// when the click state is gone (older build, lost registry entry, steered turn).
export function rememberV2Card(channelId, userId, messageId) {
  if (!channelId || !messageId) return;
  registry.recentV2Cards.set(`${channelId}:${userId || "anon"}`, {
    messageId,
    at: Date.now(),
    answeredAt: 0,
  });
}

export function markV2CardAnswered(channelId, userId, messageId) {
  const key = `${channelId}:${userId || "anon"}`;
  const cur = registry.recentV2Cards.get(key);
  if (cur && cur.messageId === messageId) cur.answeredAt = Date.now();
  else registry.recentV2Cards.set(key, { messageId, at: Date.now(), answeredAt: Date.now() });
}

export function peekV2Card(channelId, userId, maxAgeMs = 60 * 60 * 1000) {
  const cur = registry.recentV2Cards.get(`${channelId}:${userId || "anon"}`);
  if (!cur) return null;
  const age = Date.now() - (cur.answeredAt || cur.at);
  if (age > maxAgeMs) return null;
  return cur.messageId;
}

// Sends a Components V2 message. Returns the message id + question state so the
// caller can react to clicks exactly like classic questions (reused handlers).
export async function sendV2(channel, spec, fromUserId, files = []) {
  if (!spec || !Array.isArray(spec.items) || !spec.items.length) return null;
  const accent = v2AccentToNumber(spec.accent);
  const first = v2SpecToComponents(spec.items, accent, files, false, null);
  if (!first.has) return null;
  const payload = {
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
  };
  const sendableFiles = (files || []).filter(Boolean).map((f) => ({
    attachment: f.attachment || f.buffer, name: f.name,
  })).filter((f) => f.attachment && f.name);
  if (sendableFiles.length) payload.files = sendableFiles;
  if (first.top.length) payload.components = first.top;
  const msg = await channel.send(payload).catch(() => null);
  if (!msg) return null;
  // Re-render with question rows wired to this message id.
  const second = v2SpecToComponents(spec.items, accent, files, true, msg.id);
  if (second.has) {
    // interactive rows are added inside the container by the builder, so the
    // card is the single merged component block
    await msg.edit({ components: second.top }).catch(() => {});
    registerQuestionState(msg.id, {
      title: second.rows.titles?.find(Boolean) || "Options",
      options: second.rows.options || [],
      multi: false,
      input: second.rows.input || [],
      fromUserId,
      // keep the card on answer: the handler re-renders the spec without its
      // button rows plus an answer note, instead of wiping components
      v2: true,
      // cv2 cards continue in place by default: the answered card keeps its
      // content, and the agent's next spec edits this same message
      inline: true,
      specItems: spec.items.filter((i) => i && i.type !== "buttons"),
      accent,
    });
  }
  rememberV2Card(channel.id, fromUserId, msg.id);
  return msg.id;
}
