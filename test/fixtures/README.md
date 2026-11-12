# Test-only recitation fixtures

`Al-Fatiha-CC0.ogg` is an Ogg Vorbis recording of Al-Fatiha by Ibrahimmusa4, downloaded from [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:AlF%C4%81tihatulKit%C4%81b.ogg). The file page states that the uploader released it under the [CC0 1.0 Universal Public Domain Dedication](https://creativecommons.org/publicdomain/zero/1.0/).

The Windows UI smoke test copies this file to a temporary library folder so it can exercise playback, pause/resume, track switching, removal, and measured audio levels. It is test data only: it is not imported by the application, copied into `dist`, or listed in Tauri bundle resources.

`audio-formats/` contains 2-second derivatives of that CC0 recording covering the formats and codecs the local spatial decoder advertises: PCM WAV (16-bit and 24-bit), FLAC, MP3 CBR and VBR, AAC and ALAC in M4A, AAC in audio-only MP4 and in MP4 with a video track first, Vorbis and Opus in OGG, Opus in `.opus` and audio-only WebM, and Vorbis in audio-only WebM. All files are test data only and are not bundled with the application.

SHA-256:

| File | SHA-256 |
| --- | --- |
| `Al-Fatiha-CC0.ogg` | `59a4eef339d3e42aeaf9b77a6423297a0f830e4872783fc0718a64862b02df32` |
| `audio-formats/recitation-short.wav` | `1a4045716635643b5523eda31d47f2830b67c1f50619d1a02ec879fdb4d25918` |
| `audio-formats/recitation-short-24bit.wav` | `3fd1a57723a61e1658eb9d5af5a560ae301d3951b17d3d984c47652bda2e9ee3` |
| `audio-formats/recitation-short.flac` | `6b2d3d2ad15d6d2df43d52e4397f960029837a8c18b8ebe6e79ea4478cf52575` |
| `audio-formats/recitation-short.mp3` | `cfcaf2ed238e82816bd0347b75f8e01181b5834bf9e2f5977d15f8a094114973` |
| `audio-formats/recitation-short-vbr.mp3` | `8c8ec26515c5f98919f44aba071d7bc7dd66720ba10e6ffaa2d8927f9f44181f` |
| `audio-formats/recitation-short.m4a` | `1c5bf551c47a5b8d066d7325cb89129638f486838cc4e7c820966ba043df0cf9` |
| `audio-formats/recitation-alac.m4a` | `527fd5bc17b6e9d718a650e75e850832020473bee3f14be36ca5116f1fabf9be` |
| `audio-formats/recitation-audio-only.mp4` | `14ef0e62d76019abb9b49a4f16e112184c80b0aa04666d38b296eb88ed6cdfa9` |
| `audio-formats/recitation-video-first.mp4` | `d82e6efc9e8203df2499d2e0fd6bb52055e48476a744d584cd9bcc3d32b7088e` |
| `audio-formats/recitation-short.ogg` | `2062ba222ad946326de6b758340acacfb3301b41de8f0112ffc7a5d747a199db` |
| `audio-formats/recitation-short.oga` | `2062ba222ad946326de6b758340acacfb3301b41de8f0112ffc7a5d747a199db` |
| `audio-formats/recitation-opus.ogg` | `09d18fbce0383de7fcad1a7e95fce5a811f33ed5c777c857c8cfbedfd79aac15` |
| `audio-formats/recitation-short.opus` | `09d18fbce0383de7fcad1a7e95fce5a811f33ed5c777c857c8cfbedfd79aac15` |
| `audio-formats/recitation-webm-opus.webm` | `b78cc95d481dd37f397440e82a6a7f6c4ef356758b4175b7713eedeecd9e2e48` |
| `audio-formats/recitation-webm-vorbis.webm` | `990792ecf9d6a4c3d0d835f371fa7b74ff6a93312bb709f3bbbc079ea1cc4575` |
