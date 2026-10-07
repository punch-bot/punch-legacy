---
name: attachments
description: Attach files to Discord replies with the <attachment path="..."> tag
---

# Attachments

- users' incoming files are saved under `/work/attachments/`, and the turn gives you the exact path. read the file with your tools; images and PDFs are not injected inline for you.
- attach any file (screenshot, generated, or downloaded) by appending this tag to the reply:

```text
<attachment path="relative/path/to/file"></attachment>
```

- Punch strips the tag and uploads the file. still write a normal reply explaining what it is.
