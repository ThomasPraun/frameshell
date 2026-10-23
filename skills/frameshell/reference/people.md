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
frameshell people suggest                                                # sg_… ids: "s2 in … sounds like Juan (0.82)"
frameshell people confirm sg_9c04e1d2                                    # yes: link it   (--reject: no, never ask again)
frameshell people confirm sg_51aa07c3 --person Ana                       # a suggestion naming nobody: who it is (new name = new person)
frameshell people ranges Juan                                            # spans where he speaks; --on-screen: where he shows
```

MCP: `people_list`, `people_add`, `people_rename`, `people_remove`, `people_link`, `people_unlink` (`speaker`, `angle` or `face` objects, exactly one per call), `people_scan`, `people_suggest`, `people_confirm`, `people_ranges` (`person`, `kind` `speaks` or `onscreen`, `timeline`).

- A person is an id (`p_3fa2c1`) or the exact name (ignoring case); names are unique ignoring case.
- A transcript speaker, an angle or a face anchor belongs to one person; a link to a whole transcript excludes other people's speakers of it.
- **Linking a transcript speaker, and renaming its person, writes the name into that transcript's `speakers`**, so subtitles, export and the words file show it. Angle names are not rewritten: use `multicam angle --name`.
- Link only what the person confirmed or what is certain. A link by an agent is recorded in `by` and shown as "confirmed by agent" in the app.
- **Suggestions match voices across files**: link one diarized speaker to a person (`transcribe --speakers` first), then `people suggest` names other files' speakers that sound like them. Show them to the person and confirm what they agree to; never confirm all blindly. Act on `hints` (a transcript without speakers, a stale one).
- **Suggestions match faces** once videos are scanned (`people scan`): faces are grouped across videos, and a face anchor makes its group the person's. `face-speaker`: the face on screen while a speaker talks is that speaker (one camera). `face`: a face on screen 10 s or more that nobody has, with the person it looks like or nobody ("Who is this?": show the frame at `face.anchor` and ask). A suggestion without `person` needs `confirm --person <name>`; never invent the name.
- A link whose transcript, speaker, timeline, group, angle or video is gone is `missing`: listed, ignored, never deleted (a re-run may bring it back). `unlink` still removes it.
- Edit the file by hand if you like (hand-written ids such as `p_juan` are fine); an invalid file fails the people commands only.
- `people scan` only finds faces and caches their prints under `.frameshell/people/` (derived, regenerable, never in `people.json`); it links nothing. Run it when asked, not on every import.
- People changes are not timeline operations: they apply at once, are not in `history` and review mode does not hold them. Undo with the inverse command (`unlink`, `rename`, `remove`).

## Ranges

`people ranges <person>` answers "when does Juan speak" (`--on-screen`: "when is Ana on screen") in timeline seconds of one timeline: the words of the person's linked speakers placed by the clips that play them (cuts, speed and nested timelines honoured), plus the turns of their linked angles inside the program track's shots; on screen = the shots that show their angles, plus the samples of their faces (scanned videos; the faces their anchors name and the faces grouped with them) through the video clips that show them, 0.25 s either side. Pauses under 0.5 s are merged. A clip covered by a layer above still counts.

- Spans are timeline seconds now. To cut "every part where Ana is on screen", ripple from the last span to the first, so earlier spans keep their times.
- A link that gives nothing (transcript or speaker gone, stale group, a face anchor naming no face) is listed in `warnings`.
