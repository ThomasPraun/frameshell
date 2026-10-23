# People

`people.json` (optional) says who is who across files: a **person** has a name and links to transcript speakers, multicam angles and face anchors. Without the file nothing changes. It holds names and references only, no voice or face prints.

```sh
frameshell people add Juan
frameshell people link Juan --speaker transcripts/ep1.words.json:s1      # one speaker of a transcript
frameshell people link Juan --speaker transcripts/juan-lav.words.json    # every word (his own mic)
frameshell people link Juan --angle main:g_talk:juan                     # [timeline:]group:angle
frameshell people link Juan --face assets/ep1.mp4@12.5:0.41,0.33         # a face sample: second, point x,y
frameshell people rename Juan "Juan Pérez"
frameshell people list                                                   # links; MISSING ones say why
frameshell people scan                                                   # find faces in every video (cached; minutes per hour)
```

MCP: `people_list`, `people_add`, `people_rename`, `people_remove`, `people_link`, `people_unlink`, `people_scan` (`speaker`, `angle` or `face` objects, exactly one per call).

- A person is an id (`p_3fa2c1`) or the exact name (ignoring case); names are unique ignoring case.
- A transcript speaker, an angle or a face anchor belongs to one person; a link to a whole transcript excludes other people's speakers of it.
- **Linking a transcript speaker, and renaming its person, writes the name into that transcript's `speakers`**, so subtitles, export and the words file show it. Angle names are not rewritten: use `multicam angle --name`.
- Link only what the person confirmed or what is certain. A link by an agent is recorded in `by` and shown as "confirmed by agent" in the app.
- A link whose transcript, speaker, timeline, group, angle or video is gone is `missing`: listed, ignored, never deleted (a re-run may bring it back). `unlink` still removes it.
- Edit the file by hand if you like (hand-written ids such as `p_juan` are fine); an invalid file fails the people commands only.
- `people scan` only finds faces and caches their prints under `.frameshell/people/` (derived, regenerable, never in `people.json`); it links nothing. Run it when asked, not on every import.
- People changes are not timeline operations: they apply at once, are not in `history` and review mode does not hold them. Undo with the inverse command (`unlink`, `rename`, `remove`).
