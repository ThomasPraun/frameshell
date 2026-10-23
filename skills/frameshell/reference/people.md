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
frameshell people ranges Juan                                            # spans where he speaks; --on-screen: where he shows
```

MCP: `people_list`, `people_add`, `people_rename`, `people_remove`, `people_link`, `people_unlink` (`speaker`, `angle` or `face` objects, exactly one per call), `people_ranges` (`person`, `kind` `speaks` or `onscreen`, `timeline`).

- A person is an id (`p_3fa2c1`) or the exact name (ignoring case); names are unique ignoring case.
- A transcript speaker, an angle or a face anchor belongs to one person; a link to a whole transcript excludes other people's speakers of it.
- **Linking a transcript speaker, and renaming its person, writes the name into that transcript's `speakers`**, so subtitles, export and the words file show it. Angle names are not rewritten: use `multicam angle --name`.
- Link only what the person confirmed or what is certain. A link by an agent is recorded in `by` and shown as "confirmed by agent" in the app.
- A link whose transcript, speaker, timeline, group, angle or video is gone is `missing`: listed, ignored, never deleted (a re-run may bring it back). `unlink` still removes it.
- Edit the file by hand if you like (hand-written ids such as `p_juan` are fine); an invalid file fails the people commands only.
- People changes are not timeline operations: they apply at once, are not in `history` and review mode does not hold them. Undo with the inverse command (`unlink`, `rename`, `remove`).

## Ranges

`people ranges <person>` answers "when does Juan speak" (`--on-screen`: "when is Ana on screen") in timeline seconds of one timeline: the words of the person's linked speakers placed by the clips that play them (cuts, speed and nested timelines honoured), plus the turns of their linked angles inside the program track's shots; on screen = the shots that show their angles. Pauses under 0.5 s are merged. Faces are not used yet; a clip covered by a layer above still counts.

- Spans are timeline seconds now. To cut "every part where Ana is on screen", ripple from the last span to the first, so earlier spans keep their times.
- A link that gives nothing (transcript or speaker gone, stale group) is listed in `warnings`.
