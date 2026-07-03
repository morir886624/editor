# Bundled font licenses

All font files in this directory are mirrored from Google Fonts (css2 API,
woff2, `arabic` + `latin` + `latin-ext` subsets) and are licensed under the
**SIL Open Font License 1.1** (<https://openfontlicense.org>). They may be
bundled, self-hosted, and used in commercial products; they may not be sold
by themselves.

| Family           | Files                          | Source                                            |
| ---------------- | ------------------------------ | ------------------------------------------------- |
| Amiri            | `amiri-400/700-*.woff2`        | <https://fonts.google.com/specimen/Amiri>         |
| Amiri Quran      | `amiri-quran-400-*.woff2`      | <https://fonts.google.com/specimen/Amiri+Quran>   |
| Scheherazade New | `scheherazade-new-*.woff2`     | <https://fonts.google.com/specimen/Scheherazade+New> |
| Lateef           | `lateef-400/700-*.woff2`       | <https://fonts.google.com/specimen/Lateef>        |

## Deliberately NOT bundled: KFGQPC HAFS Uthmanic Script

The KFGQPC HAFS (Uthmani) font is published by the **King Fahd Glorious
Quran Printing Complex** (<https://fonts.qurancomplex.gov.sa>) under its own
license, not the OFL: it is free to use for displaying the Quran, but it
**must not be modified, renamed, or sold**, and redistribution terms are the
Complex's to set — so this app does not redistribute it. Users can import
their own copy at runtime (Text panel → Arabic / Quran → Import); the file
never leaves the browser session, and complying with the KFGQPC license is
the user's responsibility.
