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
} from "discord.js";
import { registry } from "../core/registry.js";

const EMBED_RE = /<embed\s*>([\s\S]*?)<\/embed>/gi;
const QUESTION_RE = /<question\b([^>]*)>([\s\S]*?)<\/question>/gi;
const QUESTION_OPTION_RE = /^\s*(?:[-*•]|\d+[.)])\s+(.+?)\s*$/;

function buildEmbedFromJson(j) {
  if (!j || typeof j !== "object") return null;
  const e = new EmbedBuilder();
  if (j.title) e.setTitle(String(j.title).slice(0, 256));
  if (j.description) e.setDescription(String(j.description).slice(0, 4096));
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
        e.addFields({ name: String(f.name).slice(0, 256), value: String(f.value).slice(0, 1024), inline: !!f.inline });
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
  if (q.description) embed.setDescription(q.description.slice(0, 4096));
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
