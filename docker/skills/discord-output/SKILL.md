---
name: discord-output
description: Render Discord reactions, spoilers, embeds, and questions with punch tags
---

# Discord output

- to react to the message that triggered the turn, append one or more tags such as `<react emoji="✅"></react>`. Punch applies and strips them; don't call Discord's API. for a simple acknowledgment, prefer either a reaction or short text rather than both.
- wrap text in `||double pipes||` for a Discord spoiler. attached images are not spoiler-blurred.
- create a rich embed with an `<embed>` tag containing JSON. supported fields include `title`, `description`, `url`, `color`, `author`, `thumbnail`, `image`, `footer`, `fields`, and `timestamp`. Punch strips the tag and renders up to 10 valid embeds.
- ask users to choose with a literal `<question>` tag. list options inside it; five or fewer render as buttons and larger lists render as a dropdown. use `multi`, `style="buttons"`, `style="select"`, or `style="checkbox"` when needed.
- add `input="Field;Another field"` to collect free text. keep option labels at most 80 characters, checkbox labels at most 10 characters, and forms at most 5 fields.
- the built-in `question` / `AskUserQuestion` tool is disabled over Discord and must never be called. emit the literal tag in normal reply text so Punch can render it.
