# Голосовые в чат лиги — разведка (сырые находки)

Файл ведётся подагентом-исследователем по ходу работы. Каждая строка = проверенный
факт + источник. Ничего в репозитории не правится, это единственный записываемый файл.
Начат 2026-09-05.

---

## РЕКОМЕНДАЦИЯ (одним куском)

**Формат:** `audio/webm;codecs=opus`, моно, `audioBitsPerSecond: 24000`. Пишется нативно в
Chrome/Edge (и в Firefox, и в Safari 18.4+), играется нативно в Chrome, Firefox и в
Safari 17.5+/iOS 17.4+. **Транскодирования на сервере не нужно ни в одном случае.**
Единственная развилка — Safari до 18.4 (iOS 17.x–18.3): он умеет писать только
`audio/mp4` (AAC), и этот файл Chrome играет без проблем. Поэтому клиент берёт первый
поддержанный из `['audio/webm;codecs=opus','audio/mp4']`, приёмник проверяет ДВЕ магии и
отдаёт соответствующий `Content-Type`. Это +10 строк, а не транскодер.
🔴 Чего НЕ делать: `audio/mp4;codecs=mp4a.40.2` на Windows — Chrome отдаёт этот путь
Media Foundation, где разрешены только 96/128/160/192 кбит/с, и минута речи весит 720 КБ
вместо 180 КБ (§1). И не WAV, как Nextcloud, — там минута 5.6 МБ (§4.2).

**Предел длины: 60 секунд** с обратным отсчётом и автостопом. Байты этого не требуют
(2 МБ при 24 кбит/с — это 11 минут), требует чтение ленты: голосовое дольше минуты в общем
чате никто не слушает. Технически поднять до 5 минут ничего не стоит (900 КБ) — это решение
владельца, а не ограничение. **Битрейт задать явно обязательно:** без него Chrome берёт
OPUS_AUTO ≈49 кбит/с, и на десятиминутном лимите файл вылетит за `MAX_ATT` уже ПОСЛЕ записи.

**Библиотеки: не брать ни одной.** Запись, живые уровни, секундомер, проигрывание, скорость
и скачивание — это `MediaRecorder` + `AnalyserNode` + `<audio>`, суммарно ~60 строк, и
ровно так сделан минималистичный эталон, у которого в `package.json` НОЛЬ рантайм-зависимостей
(§4.3). Ближайший кандидат с реальной пользой — `opus-recorder` (его берёт Element) — стоит
376 КБ wasm ради единого Ogg/Opus, который как раз в Safari и не играется (§5).

Длительность считать секундомером и везти в теле сообщения: у webm из MediaRecorder
`audio.duration` равно `Infinity` (§6.4). Волну, если захочется, — 40 чисел из того же
AnalyserNode при записи, не декодированием файла при показе.

---

## 0. Что уже есть в проекте (прочитано в коде)

`routing/league-receiver.js`:
- `MAX_ATT = 2 * 1024 * 1024` — байт вложения ПОСЛЕ декодирования base64 (строка 97).
- `MAX_CHAT_BODY = 3 * 1024 * 1024` — потолок тела POST /chat (строка 95); комментарий там же:
  «вложение 2 МБ в base64 весит ~2,67 МБ, плюс текст и поля».
- `isWebp(b)` (строка 405) — тип решают БАЙТЫ: `RIFF` в 0..4 и `WEBP` в 8..12.
- `attFile(seq)` (439) — имя файла из ЧИСЛА seq: `<seq>.webp`, обход каталога невозможен.
- `handleAtt(res, seq)` (935) — отдаёт `Content-Type: image/webp`, `max-age=86400`.
- `ATT_RE = /^\/chat\/att\/(\d{1,15})\.webp$/` (942).
- Чистка НЕ по возрасту 30 суток, а по числу сообщений: `CHAT_KEEP = 1000` (104), и
  `chatAppend` при обрезке журнала зовёт `chatDropAtt` для выпавших (648–652).
  ⚠️ поправка к брифу: возрастной TTL 180 дней есть только у СРЕЗОВ (`SLICE_TTL_MS`, 112).

`routing/proxy-dashboard.html`:
- `LG_ATT_LIMIT = 2*1024*1024` (27429), `lgWebpOk()` (27419) — настоящая проверка webp
  через `toDataURL`, потому что канвас молча отдаёт png.
- `lgChatAttSet(file)` (28223) — сжатие `lgFit(im,{max:1600,...})` → webp blob → `lgB64` →
  `LGC.att = {b64,bytes,w,h,url}`; в POST уходит `att:{mime:'image/webp',b64}` (28253).
- `LGC_ATT_RE = /^\/__switch\/api\/league\/chat\/att\/\d+\.webp$/` (28088) — белый список
  для `src`; если URL не совпал, путь собирается самим клиентом по `seq`.
- Хаб проксирует: `transparent-proxy.js:18097` → `handleLeagueAtt` (9458) → `leagueReq`
  `/chat/att/<seq>.webp`. Регексп в проксе тоже ждёт `.webp` (9467).
- Звук в чате уже синтезируется через `AudioContext` (`lgBeep`, 27963), и там уже стоит
  правильная защита от автоплей-политики: контекст будят на `pointerdown`/`keydown`
  (`lgAudioArm`, 27951). Для проигрывания голосовых это уже решённая половина задачи.

Вывод по интеграции: путь «браузер жмёт → base64 в теле → приёмник проверяет байты →
файл по номеру → отдача по номеру» переносится на голос без изменений архитектуры.
Меняется только: расширение/mime, магия в проверке, и предел размера.

---

## 1. Запись в браузере — что реально доступно

### Chrome (Windows) — по исходникам Chromium, не по блогам

`third_party/blink/renderer/modules/mediarecorder/media_recorder_handler.cc`
(https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/modules/mediarecorder/media_recorder_handler.cc):
- Контейнеры для аудио: `audio/webm`, `audio/x-matroska`, `audio/matroska`, `audio/mp4`
  (`CanSupportAudioType`, ~140). **`audio/ogg` НЕ поддерживается** — Ogg умеет только Firefox.
- Кодеки: `kAudioCodecs[] = {"opus","pcm"}` для webm/matroska;
  `kAudioCodecsForMp4[] = {"mp4a.40.2","opus"}` (mp4a только в официальной сборке Chrome,
  `USE_PROPRIETARY_CODECS`; в чистом Chromium его нет).
- `AudioStringToAudioCodec`: "opus"→Opus, "pcm"→PCM, "mp4a.40.2"→AAC.

`audio_track_recorder.cc`: `GetPreferredCodec()` **всегда возвращает Opus**, независимо от
контейнера. → Плейн `audio/mp4` в Chrome даёт **Opus внутри MP4**, а не AAC. AAC получается
только явной строкой `audio/mp4;codecs=mp4a.40.2`.
Подтверждение с другой стороны (замер разработчика, сентябрь 2024):
https://zeoninc.com/blog/2024/09/12/september3-2/ — `isTypeSupported` даёт true для
`audio/mp4`, `audio/mp4;codecs=opus`, `audio/mp4;codecs=mp4a.40.2`; плейн `audio/mp4`
выдаёт opus, а `mp4a.40.2` — «実際出力してみると確かにAACでした» (реально AAC).
Там же жалоба: полученный из Chrome MP4 у него не заиграл на iOS/Mac (причина не
установлена, ffmpeg/MP4Box файл едят). Одиночное свидетельство, не проверено.

Когда MP4 появился в MediaRecorder: ChromeStatus 5163469011943424 («MP4 container support
for MediaRecorder»), stage 260 (shipped) = **desktop/android/webview 126**, shipping_year
2024. Dev trial был 120. Получено через API chromestatus (`/api/v0/features/...`).
Intent-to-ship: https://groups.google.com/a/chromium.org/g/blink-dev/c/p1OMVj1FrMI

### 🔴 Ключевое про AAC на Windows: минимум 96 кбит/с, промежуточных нет

`media/gpu/windows/mf_audio_encoder.cc`:
```
constexpr int kDefaultBitrate = 96000;
constexpr std::array<int, 4> kSupportedBitrates = {96000, 128000, 160000, 192000};
constexpr std::array<int, 2> kSupportedSampleRates = {44100, 48000};
...
*bitrate = options.bitrate.value_or(kDefaultBitrate);
if (!std::ranges::contains(kSupportedBitrates, *bitrate))
    return EncoderStatus::Codes::kEncoderUnsupportedConfig;
```
То есть `audioBitsPerSecond: 32000` вместе с `codecs=mp4a.40.2` на Windows — это не
«тихо округлит», а **отказ конфигурации**. Причина внешняя: MS Media Foundation AAC encoder
принимает `MF_MT_AUDIO_AVG_BYTES_PER_SECOND` только 12000/16000/20000/24000 байт/с
(= 96/128/160/192 кбит/с), по умолчанию 12000 = 96 кбит/с и для моно, и для стерео —
https://learn.microsoft.com/en-us/windows/win32/medfound/aac-encoder
Следствие: минута речи в AAC с Windows = 720 КБ против 240 КБ у Opus 32k. Втрое дороже
при том же качестве.

### Opus в Chrome: дефолт ≈49 кбит/с, но настраивается

`third_party/blink/renderer/modules/mediarecorder/audio_track_opus_encoder.cc`:
- `kOpusPreferredSamplingRate = 48000`, `kOpusPreferredBufferDurationMs = 60` (кадр 60 мс,
  2880 сэмплов), вход ресемплится к 48 кГц, каналы `min(mic, 2)`.
- `bitrate = bits_per_second_ > 0 ? bits_per_second_ : OPUS_AUTO` (152–155).
`media_recorder.cc`: `audioBitsPerSecond` уходит как есть (`min(value, INT_MAX)`);
`kDefaultAudioBitRate = 128e3` применяется НЕ по умолчанию, а только когда задан общий
`bitsPerSecond` (тогда 10% его уходит аудио и клампится в 5000..510000 —
`kSmallestPossibleOpusBitRate = 5000`, `kLargestPossibleOpusBitRate = 510000`).
→ Если `audioBitsPerSecond` не задать вовсе, работает OPUS_AUTO. У libopus авто =
`60*Fs/frame_size + Fs*channels`; при Fs=48000, кадре 2880 и моно это 1000+48000 =
**≈49 кбит/с**. (Формулу надо подтвердить по исходнику libopus — TODO.)

### Safari / WebKit

- MediaRecorder есть с Safari 14.1 (caniuse `mediarecorder`, macOS; iOS 14.3+).
- 🟢 **Safari 18.4 (март 2025) научился ЗАПИСЫВАТЬ WebM с Opus.** Первичный источник —
  webkit.org: «MediaRecorder in WebKit for Safari 18.4 now supports creating WebM files
  using the Opus audio codec» + VP8/VP9 для видео; там же добавлены fragmented MP4,
  ALAC/PCM и поддержка контейнера Ogg для Opus/Vorbis (macOS 15.4, iOS/iPadOS 18.4).
  https://webkit.org/blog/16574/webkit-features-in-safari-18-4/
- 🟢 **Проигрывание Opus в WebM у Safari раньше записи**: caniuse `opus` —
  Safari 17.4 → `a #2` («Supported in a WebM container» + регрессия
  https://bugs.webkit.org/show_bug.cgi?id=245428), 17.5 → `a #3` (WebM, все битрейты),
  18.4 → `a #4` (для macOS 15.4+). iOS Safari: 17.4 → `a #3`, **18.4 → полное `y`**.
  caniuse `webm`: iOS Safari `y` с 17.4, десктопный Safari `y` с 16.0.
  Данные взяты из features-json репозитория caniuse (opus.json, webm.json, mediarecorder.json).
  Первичное подтверждение по контейнеру — release notes Safari 17.4: «While the WebM container
  (with both the VP8 and VP9 video codecs) has been fully supported on macOS since Safari 14.1
  … Now, WebM is fully supported everywhere» (там же добавлен Vorbis; Opus на платформах Apple
  был доступен и раньше) — https://webkit.org/blog/15063/webkit-features-in-safari-17-4/
- До 18.4 Safari умеет записывать только `audio/mp4` (AAC) — это и есть та «другая
  историческая раскладка». Chrome такой файл играет без вопросов (caniuse `aac`: y везде).

### Промежуточный вывод по формату

ОДНОГО формата, который пишется и играется абсолютно везде, нет только из-за старых
Safari (iOS 17.x–18.3 пишут mp4/aac). Но транскодирование не нужно НИ В ОДНОМ случае:
- `audio/webm;codecs=opus` — пишет Chrome/Edge/Firefox/Safari 18.4+; играет Chrome, FF,
  Safari 17.5+/iOS 17.4+.
- `audio/mp4` (AAC) — пишет старый Safari; играет всё, включая Chrome.
Минимальная развилка: клиент берёт первый поддерживаемый из двух строк, сервер проверяет
ДВЕ магии (EBML `1A 45 DF A3` для webm, `ftyp` на смещении 4 для ISO-BMFF) и отдаёт
соответствующий Content-Type. Это +10 строк к приёмнику, а не транскодер.

---

## 2. Размер (расчёт от битрейта, проверяемый арифметикой)

байт = битрейт × секунды / 8. Контейнер webm добавляет ~4–7 Б на кадр (при 60-мс кадрах
это ~17 кадров/с ≈ 100 Б/с) плюс ~0.3 КБ заголовков — 2–3% сверху, в таблице не учтено.

| битрейт | 1 с | 15 с | 30 с | 60 с | 5 мин |
|---|---|---|---|---|---|
| Opus 16k (моно, WB-речь) | 2 КБ | 30 КБ | 60 КБ | 120 КБ | 600 КБ |
| **Opus 24k (рекомендация xiph для VoIP/подкаста)** | 3 КБ | **45 КБ** | **90 КБ** | **180 КБ** | 900 КБ |
| Opus 32k (SWB-речь с запасом) | 4 КБ | 60 КБ | 120 КБ | 240 КБ | 1.2 МБ |
| Opus авто в Chrome (~49k) | 6.1 КБ | 92 КБ | 184 КБ | 368 КБ | 1.8 МБ |
| AAC 96k (минимум Windows) | 12 КБ | 180 КБ | 360 КБ | **720 КБ** | 3.6 МБ ✗ |
| WAV 48k/16 бит моно (как Nextcloud) | 94 КБ | 1.4 МБ | 2.8 МБ ✗ | 5.6 МБ ✗ | — |

Рекомендованные битрейты Opus (https://wiki.xiph.org/Opus_Recommended_Settings):
VoIP моно 10–24 кбит/с («24 Kb/s should give fullband»), аудиокниги/подкасты — 24 моно /
32 стерео; речь по полосе: WB 16–20, SWB 24–28, FB 28–40 кбит/с моно.
Живое подтверждение выбора 24k — Element (см. §4).

Против нашего потолка `MAX_ATT = 2 МБ`: при Opus 24k это ~11 минут, при 32k ~8.7 минут.
**Байты не ограничивают ничего.** Ограничивать длину надо из UX и из «сколько никто не
будет слушать», а не из-за лимита. Тело POST (3 МБ) тоже не мешает: 2 МБ → 2.67 МБ base64.

---

### Формула OPUS_AUTO — подтверждена по исходнику libopus
`src/opus_encoder.c`, `user_bitrate_to_bitrate()` (строка 733):
```c
if (st->user_bitrate_bps==OPUS_AUTO)
   user_bitrate = 60*st->Fs/frame_size + st->Fs*st->channels;
```
https://raw.githubusercontent.com/xiph/opus/main/src/opus_encoder.c
При Fs=48000, frame_size=2880 (60 мс, как у Chromium), channels=1 → 1000+48000 = **49 000 бит/с**.
Это НОМИНАЛ (цель), а не факт: MediaRecorder по умолчанию включает VBR
(`GetBitrateModeFromOptions` возвращает `kVariable`, когда `audioBitrateMode` не задан),
и на речи с паузами реальный средний выходит ниже — см. замер 240 КБ/мин в §4.3.

---

## 4. Как это делают вживую (три открытых чата, код проверен)

### 4.1 Element Web (Matrix) — MediaRecorder ОТВЕРГНУТ, взят opus-recorder
`apps/web/src/audio/VoiceRecording.ts`
(https://raw.githubusercontent.com/element-hq/element-web/develop/apps/web/src/audio/VoiceRecording.ts):
- `import Recorder from "opus-recorder/dist/recorder.min.js"` — libopus в WASM, выход **Ogg/Opus**.
  MediaRecorder не используется вообще: формат обязан быть один и тот же во всех браузерах,
  потому что в событии Matrix (MSC3245) лежит `audio/ogg` и волна.
- `CHANNELS = 1` («stereo isn't important»), `SAMPLE_RATE = 48000` («48khz is what WebRTC
  uses. 12khz is where we lose quality»).
- **`bitrate: 24000` — комментарий в коде: «recommended Opus bitrate for high-quality VoIP»**;
  `encoderApplication: 2048` (= VOIP). Для «музыкального» режима отдельный профиль 96000.
- `TARGET_MAX_LENGTH = 900` секунд (15 минут), «somewhat arbitrary, though longer == larger
  files»; предупреждение за `TARGET_WARN_TIME_LEFT = 10` с до конца.
- Волна: `RECORDING_PLAYBACK_SAMPLES = 44` живых столбиков, `PLAYBACK_WAVEFORM_SAMPLES = 39`
  для ленты (`audio/consts.ts`). Считается своим AudioWorklet'ом (`RecorderWorklet.ts`),
  без библиотек визуализации.
- Длительность и волна уезжают В СОБЫТИИ, а не вычисляются из файла:
  `VoiceRecordComposerTile.tsx` — `Math.round(durationSeconds*1000)` и
  `thumbnailWaveform.map(v => Math.round(v*1024))`.
- `getUserMedia` просит `channelCount: 1`, `echoCancellation`/`noiseSuppression` как `ideal`.

### 4.2 Nextcloud Talk — WAV через полифилл (пример того, как НЕ надо)
`src/components/NewMessage/NewMessageAudioRecorder.vue`
(https://raw.githubusercontent.com/nextcloud/spreed/main/src/components/NewMessage/NewMessageAudioRecorder.vue):
- `new MediaRecorder(stream, { mimeType: 'audio/wav' })` — это не нативный MediaRecorder,
  а полифилл: в `package.json` лежат `extendable-media-recorder ^9.2.40` и
  `extendable-media-recorder-wav-encoder ^7.0.140`.
- Файл: `new File([blob], 'Voice message ... .wav', {type:'audio/wav'})`, имя режется до 146 симв.
- Ограничения длины в компоненте НЕТ. Таймер — `setInterval(...,1000)` с ручным
  инкрементом секунд (в фоне вкладки такой таймер поедет: Chrome душит таймеры до 1/мин).
- Отказ микрофона обработан явно: `exception.name === 'NotAllowedError'` → «Access to the
  microphone was denied», иначе «Microphone either not available or disabled in settings».
- `killStreams()` глушит треки — иначе индикатор микрофона в браузере/ОС не гаснет.
- Волны нет вообще, только счётчик времени.
- Цена решения: WAV 48 кГц/16 бит моно = 94 КБ/с → минута ≈ **5.6 МБ** (стерео вдвое).
  Наш потолок 2 МБ такое переживёт только ~21 секунду.

### 4.3 mattermost-plugin-voice-message — минималистичный эталон БЕЗ зависимостей
https://github.com/WismutNaN/mattermost-plugin-voice-message
`webapp/package.json` — **ни одной runtime-зависимости**, только webpack/babel/ts в dev.
Весь клиент: `useRecorder.ts` (6.2 КБ), `RecorderPanel.tsx` (8.5 КБ), `VoicePost.tsx` (9.2 КБ),
`api.ts` (4.8 КБ).
- Выбор формата (`api.ts`, `bestMimeType()`): перебор
  `['audio/webm;codecs=opus','audio/ogg;codecs=opus','audio/webm','audio/ogg','audio/mp4']`
  через `MediaRecorder.isTypeSupported`, берётся первый поддержанный. Битрейт НЕ задаётся.
- Таблица из README: Chrome/Edge → WebM+Opus, Firefox → OGG+Opus, Safari ≥14.1 → MP4,
  десктоп-приложение → WebM+Opus. **Транскодирования на сервере нет** — mime сохраняется
  в `post.Props["voice_mime_type"]`, расширение выводится из него (`extForContentType`,
  дефолт `.webm`).
- README: «**Small file size — Opus/WebM ≈ 240 КБ/мин**» — это реальный замер на речи
  при незаданном битрейте (номинал 49 кбит/с дал бы 368 КБ/мин; разницу съедает VBR и паузы).
- Лимиты по умолчанию: `Max Recording Duration = 600` с, `Max File Size = 50 МБ`,
  `Transcription Max Duration = 300` с. Стоп по времени делает клиент:
  `if (elapsed >= maxSeconds) rec.stop()` в `setInterval(...,100)`, а время считается
  разностью `Date.now() - t0` (не инкрементом — поэтому дрожание таймера не искажает цифру).
- Живые уровни: `AudioContext` + `AnalyserNode`, `fftSize = 256`, `getByteFrequencyData`,
  усреднение в **32 столбика**, обновление в `requestAnimationFrame`. ~20 строк, без библиотек.
- 🪤 **Волна в ленте у них ФАЛЬШИВАЯ.** `VoicePost.tsx`: `genBars(post.id)` — детерминированный
  псевдослучайный рисунок из хеша id сообщения (`base = 0.15 + Math.abs(h%70)/100` плюс синус).
  Настоящую амплитудную огибающую они не хранят и не считают. Это осознанный обмен:
  40 декоративных столбиков дают «вид голосового», не стоя ни байта данных, ни зависимости.
- Длительность НЕ берётся из файла: уходит параметром `duration` в upload и живёт в
  `post.props.voice_duration`; из `<audio>` она читается только как проверка
  `if (isFinite(a.duration))` — прямая защита от `duration = Infinity` у webm (см. §6).
- Проигрывание: обычный `new Audio()`, `preload='metadata'`, прогресс через rAF,
  скорость `audio.playbackRate` из набора **1 / 1.25 / 1.5 / 2**.
- Транскрипция: серверная, по кнопке 📝 или авто; Whisper-совместимый API —
  DeepInfra `whisper-large-v3-turbo` (дефолт), OpenAI `whisper-1` или свой endpoint;
  результат кэшируется в `post.Props["voice_transcript"]`, повторный запрос отдаёт кэш.

Сводка по трём: **никто не транскодирует на сервере.** Двое из трёх пишут Opus (один через
WASM ради единого формата, другой нативно с развилкой по браузеру), третий пишет WAV и платит
за это мегабайтами. Волну в ленте рисует только Element, и то по своим сохранённым 39 числам;
минималист её подделывает.

---

## 5. Библиотеки — цифры и вердикт

Вес мерен скачиванием файла с jsdelivr (несжатый минифицированный), метаданные — из
registry.npmjs.org (`dist.unpackedSize`, `time`, `license`). Дата отсчёта: 2026-09-05.

| Пакет | Версия / последний релиз | Лицензия | Реальный вес в браузер | Что даёт | Брать? |
|---|---|---|---|---|---|
| `MediaRecorder` + `AnalyserNode` + `<audio>` | платформа | — | **0 КБ** | запись, живые уровни, проигрывание, скорость, скачивание | **да, это и есть решение** |
| `opus-recorder` | 8.0.5, **2021-10-15** (≈5 лет) | MIT, 0 deps | `recorder.min.js` 8 КБ + `encoderWorker.min.js` **376 КБ** (libopus в wasm) | один и тот же Ogg/Opus во всех браузерах, точный битрейт, VOIP-режим | нет |
| `wavesurfer.js` (+ `plugins/record`) | 7.12.11, 2026-07-17 (живой) | BSD-3, 0 deps | 41.8 КБ + 8 КБ | настоящая волна из декодированного аудио, клик-seek, регионы | нет |
| `extendable-media-recorder` (+ wav-encoder) | 9.2.40 / 7.0.140, 2026 (живой) | MIT, **7 + 4 зависимости** | ~280 КБ распакованных, 365 файлов | MediaRecorder с ЧУЖИМ энкодером (WAV) | нет |
| `RecordRTC` | 5.6.2, 2021-03-09 | MIT | 78.6 КБ | комбайн: видео, скрин, аудио, GIF | нет |
| `audio-recorder-polyfill` | 0.4.1, **2020-11-19** | MIT | 6.7 КБ | MediaRecorder→WAV для Safari < 14.1 | нет |
| `opus-media-recorder` | 0.8.0, **2020-06-09** (мёртв) | MIT | 1.1 МБ распакованных | то же, что opus-recorder, но полифиллом | нет |
| `mic-recorder-to-mp3` / `vmsg` | 2.2.2 (2020) / 0.4.0 (2021) | MIT / CC0 | 2.6 МБ / 218 КБ | MP3 через wasm | нет |
| `peaks.js` | 4.0.0, 2025-08-30 | **LGPL-3.0** | 4.2 МБ распакованных | редактор волны от BBC | нет |

### Почему «нет» даже opus-recorder — на примере Element
Element платит за единый Ogg/Opus дважды. Первый раз — 376 КБ энкодера. Второй — декодером:
`apps/web/src/audio/Playback.ts:177–186` при провале нативного декода делает
`decodeOgg(fallbackBuf)` (тот же wasm, но decoderWorker) и переигрывает в WAV, с
комментарием в коде: «This error handler is largely for Safari, **which doesn't support
Opus/Ogg very well**». То есть выбранный ради «одного формата» контейнер как раз в Safari и
не играется — Ogg появился у Apple только в 18.4 (webkit.org, см. §1).
Плюс на каждое проигрывание они декодируют файл целиком в `AudioBuffer`, чтобы посчитать
настоящую волну («We don't exactly trust the user-provided waveform to be accurate»,
`Playback.ts:189–193`).
Для нас это чистый минус: у нас Chrome, `audio/webm;codecs=opus` пишется нативно, играется
нативно, и никакого общего знаменателя докупать не нужно.

### Что реально заменяет библиотеку (в строках)
- живые уровни: `AudioContext` → `createMediaStreamSource` → `AnalyserNode{fftSize:256}` →
  `getByteFrequencyData` → усреднить в 32 столбика → rAF. ~20 строк
  (эталон: `useRecorder.ts:updateLevels` в mattermost-plugin-voice-message).
- секундомер и стоп по лимиту: `setInterval(...,100)` + `Date.now()-t0`. ~6 строк.
- проигрывание с прогрессом и скоростью: `new Audio(url)`, `playbackRate`, rAF-тик. ~15 строк.
- волна в ленте: посчитать 40 чисел ОДИН раз при записи из того же AnalyserNode и положить
  в сообщение рядом с длительностью (как Element кладёт 39). 0 зависимостей, 0 декодирования
  при показе. Либо вообще декоративная из хеша seq, как у минималиста.

---

## 6. Грабли

### 6.1 Микрофон на http://localhost — РАЗРЕШЁН, но origin считается буквально
`http://localhost`, `http://127.0.0.1`, `http://*.localhost` — «potentially trustworthy
origin», secure context без HTTPS
(https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts). Значит на нашем
`http://localhost:8200` `getUserMedia` работает штатно и промпт показывается как на https.
- 🪤 **`localhost:8200`, `127.0.0.1:8200` и `127.0.0.1:20100` — ТРИ РАЗНЫХ origin.**
  Разрешение микрофона Chrome помнит на origin, поэтому «разрешил один раз» придётся
  сделать в каждом адресе, которым владелец открывает дашборд. В репозитории живут все три
  (грепом: 17 упоминаний `http://127.0.0.1:20100`, 11+3 `http://localhost:8200`).
- 🪤 Открыть дашборд по **LAN-IP по http** — микрофона нет ВООБЩЕ: в insecure context
  `navigator.mediaDevices` равно `undefined`, и падение будет `TypeError`, а не
  `NotAllowedError` (MDN getUserMedia, § Privacy and security). Сообщение об ошибке надо
  писать про адрес, иначе человек полезет искать разрешения, которых там нет.
- Заголовков, которые могли бы отобрать микрофон, хаб не ставит: `Permissions-Policy`,
  `Feature-Policy`, `Content-Security-Policy` в `routing/*.js` и `routing/*.html` не
  встречаются ни разу (проверено грепом).

### 6.2 Отказ и прочие «нет микрофона» — четыре разных случая
Из MDN getUserMedia: `NotAllowedError` — человек нажал «Блокировать» (или блок стоял
раньше, или insecure context); `NotFoundError` — устройства нет; `NotReadableError` —
разрешение есть, но устройство занято/сломано на уровне ОС; `OverconstrainedError` —
не выполнимы constraints (например `deviceId: {exact}` от отвалившегося микрофона).
- 🪤 Промпт может **не вернуть ничего**: «It's possible for the returned promise to neither
  resolve nor reject, as the user is not required to make a choice at all» — то есть на
  `await getUserMedia` можно повиснуть навсегда, если человек закрыл шторку крестиком.
  Кнопка обязана уметь оставаться в состоянии «жду разрешения» без вечного спиннера.
- Заблокированный origin Chrome помнит: следующий вызов падает сразу, без промпта. Снять
  можно только руками через иконку в адресной строке — значит текст ошибки должен об этом
  говорить, а не предлагать «нажми ещё раз».
- Состояние можно узнать ДО записи: `navigator.permissions.query({name:'microphone'})` —
  Chrome 64+, Safari 16+, Firefox 132+ (MDN BCD `api.Permissions.permission_microphone`).
  Это дешёвый способ показать честную подсказку на кнопке.

### 6.3 Индикатор записи гаснет только по `track.stop()`
Пока трек `live`, у таба горит красный маркер, а Windows 11 держит иконку микрофона в трее.
`MediaRecorder.stop()` этого НЕ снимает — нужен `stream.getTracks().forEach(t => t.stop())`.
Оба живых примера делают это явно (`cleanup()` в `useRecorder.ts`, `killStreams()` в Nextcloud).
Забыть = человек будет считать, что его слушают после отправки.

### 6.4 `audio.duration` у webm из MediaRecorder = `Infinity`
Muxer пишет поток без длины, элемент Duration в заголовке отсутствует; в Chromium это
закрыто как WontFix (обзор проблемы и обходные пути:
https://stackoverflow.com/questions/43266295/browser-mediarecorder-api-video-controls-not-working-headers-set-incorrectly,
библиотеки-костыли: https://github.com/yusitnikov/fix-webm-duration,
https://github.com/buynao/webm-duration-fix).
Правильный обход — **не читать длительность из файла вообще**: мы её знаем от секундомера.
Оба живых примера так и делают (`post.props.voice_duration`, `isFinite(a.duration)` только
как проверка; Element кладёт `durationSeconds*1000` в событие).
Практический вывод для нас: длительность в секундах должна ехать в теле сообщения рядом с
`b64` и храниться в записи журнала — иначе в ленте нечего написать под кнопкой, а seek-бар
будет ломаться до первого проигрывания.

### 6.5 Уход со вкладки: запись выживает, а UI-таймер нет
- Заморозки не будет: тab, использующий микрофон, явно исключён из freezing на Energy Saver —
  «Provide audio or video conferencing functionality (detected using microphone, camera,
  screen/window/tab capture)» либо «a 'live' MediaStreamTrack»
  (https://developer.chrome.com/blog/freezing-on-energy-saver/).
- Тяжёлого троттлинга (раз в минуту) тоже не будет: он требует одновременно «hidden > 5 мин»,
  «chain count ≥ 5», «silent ≥ 30 с» И «WebRTC is not in use», а живой MediaStreamTrack
  считается «WebRTC in use» (https://developer.chrome.com/blog/timer-throttling-in-chrome-88).
- Но троттлинг «раз в секунду» остаётся, а `requestAnimationFrame` в скрытой вкладке не
  тикает вовсе. Отсюда два правила: секунды считать разностью `Date.now()`, а не
  инкрементом (иначе цифра поедет — ровно эта ошибка в Nextcloud), а автостоп по лимиту
  вешать на `setInterval`, не на rAF.
- Наш чат уже сам снимает опрос на `visibilitychange` — с записью это не конфликтует.

### 6.6 Автоплей
`<audio>.play()` без жеста человека отбивается `NotAllowedError`; muted-автоплей разрешён
всегда, со звуком — только после взаимодействия с доменом или по MEI
(https://developer.chrome.com/blog/autoplay). Для нас это значит: играть строго по клику,
никакого «само заиграло следующее». Половина работы уже сделана — `lgAudioArm` в дашборде
будит `AudioContext` на первом `pointerdown`/`keydown` по той же причине.

### 6.7 Что делать с уже записанным при обрыве
Чанки лежат в массиве в памяти страницы: F5, крэш вкладки или перезапуск Chrome = потеря.
Дёшево закрывается половина: не отправлять по `stop()`, а положить запись в чип-превью
рядом с полем ввода — точно как сейчас живёт `LGC.att` для картинки. Тогда провалившийся
POST (или передумал) не теряет запись, и человек видит, ЧТО уедет, до нажатия.
Полное решение — писать чанки в IndexedDB по `ondataavailable(timeslice)` — это уже
состояние на диске, которое надо чистить; за наш сценарий не окупается.
- 🪤 `MediaRecorder.stop()` асинхронен: последний `ondataavailable` приходит ПЕРЕД `onstop`,
  собирать Blob и отправлять — только из `onstop`.

### 6.8 Память и потолки
При 24–32 кбит/с десять минут записи — 1.8–2.4 МБ в памяти страницы, это ничто. Опасен
только WAV-путь (94 КБ/с → 10 минут = 56 МБ).
🪤 Если НЕ задавать `audioBitsPerSecond`, авто-битрейт (≈49 кбит/с номинал) при лимите
10 минут даст файл ~3.7 МБ — он не пройдёт `MAX_ATT = 2 МБ`, и отказ приедет ПОСЛЕ записи,
то есть после потраченных десяти минут. Либо явный битрейт, либо лимит длины,
либо проверка размера до отправки — лучше всё три.

### 6.9 Проверка типа по байтам: что она может и что нет
- webm/matroska: EBML-магия `1A 45 DF A3` в первых четырёх байтах.
- mp4/ISO-BMFF: `ftyp` на смещении 4 (`....ftyp`).
Этого достаточно, чтобы отбить не-аудио и мусор, но **это не проверка кодека**: тот же EBML
несёт и видео с дорожкой VP9. Строгая гарантия «внутри только Opus» требует разбора EBML —
это не десяток строк и в наш «без зависимостей» не влезает.
Честная формулировка ограды: магия + предел размера + `Content-Type` от НАС (браузер играет
только звук, даже если внутри окажется видеодорожка) + `X-Content-Type-Options: nosniff`
на отдаче (сейчас `handleAtt` его не ставит — стоит добавить вместе с новой ручкой).

---

## 7. Доступность

Что стоит почти ничего:
- **Длительность текстом** — она у нас уже есть от секундомера (см. §6.4), нужно только
  положить в сообщение и напечатать «0:37» рядом с кнопкой. Формат `m:ss` — как в эталоне
  (`fmt()` в `VoicePost.tsx`).
- **Скачать** — `<a href="/chat/voice/N.webm" download="golos-N.webm">`, ноль кода.
- **Клавиатура и скринридер** — кнопка `<button>` вместо div'а и `aria-label` вида
  «Голосовое от Ника, 0:37, нажми чтобы проиграть». В дашборде так уже подписан крестик
  удаления, стиль есть.
- **Скорость 1.25/1.5/2** — `audio.playbackRate`, одна строка; людям с плохим слухом чаще
  нужна как раз замедленная 0.75 — тот же параметр.
- **Не мешать тексту**: голосовое НЕ должно быть единственным содержимым сообщения —
  наш чат уже разрешает текст+вложение одним сообщением, значит подпись к голосовому
  бесплатна и её стоит просить.

Что стоит денег или CPU:
- **Транскрипция в облаке**: OpenAI Whisper — **$0.006/мин**, gpt-4o-mini-transcribe —
  **$0.003/мин** (https://developers.openai.com/api/docs/pricing);
  whisper-large-v3-turbo через OpenRouter — **$0.000003/с = $0.00018/мин**
  (https://openrouter.ai/openai/whisper-large-v3-turbo/providers), то есть 33× дешевле.
  Сто сообщений по 30 с = 50 минут = $0.30 у OpenAI и $0.01 у turbo. **Деньги здесь не
  проблема.** Проблема — что аудио уезжает третьей стороне и в приёмнике появляется ключ.
  Так делает эталон: сервер шлёт файл Whisper-совместимому API (DeepInfra turbo по
  умолчанию) и кэширует текст в `post.Props["voice_transcript"]`.
- **Транскрипция локально**: на рабочей станции УЖЕ стоит `faster-whisper 1.2.1` +
  `ctranslate2 4.8.1` (проверено: `D:\WORMALIENAIGIGANT\.venv-whisper\Lib\site-packages`).
  Денег не стоит и наружу ничего не уезжает, но считает станция, а не арендованная нода, —
  значит это не «функция чата», а ручная операция по требованию.
- **Web Speech API в браузере** — соблазнительно бесплатен: можно слушать распознавание
  ПАРАЛЛЕЛЬНО записи и приложить текст к сообщению. Два «но»: (1) облачный путь Chrome
  отправляет аудио третьей стороне — это прямо названо мотивацией в интенте на on-device
  вариант («allowing websites to ensure that neither audio nor transcribed speech are sent
  to a third-party service», https://groups.google.com/a/chromium.org/g/blink-dev/c/VNOok2dbmHM);
  (2) локальный режим (`processLocally`, `SpeechRecognition.available()`) появился только в
  **Chrome 139** (MDN BCD `api.SpeechRecognition.processLocally`), в Firefox/Safari его нет.
  ⚠️ Не проверено вживую: уживаются ли `SpeechRecognition` и `MediaRecorder` на одном
  микрофоне одновременно. Без опыта на живой машине этого утверждать нельзя.

---

## 9. Сверка с применённым решением (2026-09-05, после разведки)

Применено: `audio/webm;codecs=opus` моно + `audioBitsPerSecond: 24000`, запасной `audio/mp4`;
жёсткий стоп 120 с; предел 512 КБ со стопом на 90 %; библиотек ноль; плеер `preload="none"`,
длительность в теле; сигнатуры шести форматов (webp, webm, ogg, m4a, mp3, wav).
**Формат, битрейт, отказ от библиотек и длительность в теле — сходится с находками полностью.**

Арифметика лимитов бьётся: 120 с × 3000 Б/с = 360 КБ номинала, плюс ~12 КБ контейнера
(≈100 Б/с при кадрах 60 мс) = ~372 КБ, то есть 73 % от 512 КБ. Байтовая ограда сработает
раньше таймера только если реальный средний битрейт превысит ~31 кбит/с — при цели 24к и VBR
это возможно на громкой плотной речи, но именно для этого ограда и стоит. base64 от 512 КБ =
683 КБ, при `MAX_CHAT_BODY` 3 МБ запас четырёхкратный.

Что стоит проверить в применённом (по находкам):
1. **Ограда 90 % работает только при `rec.start(timeslice)`.** Без аргумента `ondataavailable`
   стреляет один раз в конце, и сумма размеров чанков во время записи неизвестна.
2. **Ветка Safari `audio/mp4`: не проверено, уважает ли WebKit `audioBitsPerSecond`.** Если
   игнорирует и пишет своим дефолтом, при 120 с в 512 КБ не уложится, и на Safari лимитом
   станет байтовая ограда (запись оборвётся секунд на 40–60). Симптом: у одного участника
   голосовые систематически короче лимита.
3. **Строки `mp4a.40.2` в коде быть не должно** — на Windows Chrome отдаёт этот путь Media
   Foundation, где 24000 не в списке разрешённых битрейтов, и конфигурация ОТКАЗЫВАЕТ (§1).
   Плейн `audio/mp4` в Chrome безопасен (там Opus), но и не нужен: webm поддержан всегда.
4. **Сигнатура m4a — `ftyp` на смещении 4, а не бренд.** Safari/WebKit ставит в `ftyp` разные
   бренды (`isom`/`mp42`/`iso5`); проверка на конкретный бренд отобьёт часть валидных файлов.
5. **wav и webp делит префикс `RIFF`** — различать строго по 8..12 (`WEBP` против `WAVE`),
   иначе одна проверка съест чужой формат. И wav годится только как принимаемый формат: при
   94 КБ/с в 512 КБ влезает 5.4 секунды, целью записи он быть не может.
6. **mp3 по frame-sync (`FF Ex/FF Fx`) даёт ложные срабатывания** — надёжен только `ID3`.
   Браузер mp3 без библиотеки не производит, так что это формат «принесли руками».
7. **`preload="none"` означает, что до первого клика длительности нет ни у кого** — прогресс
   считать `currentTime / длительность_из_тела`, а не от `audio.duration`; и первому клику
   нужен видимый «грузится», иначе тишина после нажатия читается как поломка.
8. **`X-Content-Type-Options: nosniff`** на новой ручке отдачи (у `handleAtt` его нет).

---

## 10. Что было сделано в этой сессии
- [x] Chrome: контейнеры/кодеки по исходникам
- [x] Windows AAC: минимум 96 кбит/с
- [x] Safari 18.4 пишет webm/opus; играет с 17.4/17.5
- [x] Размеры
- [x] libopus: формула OPUS_AUTO подтверждена
- [x] Живые чаты: Element, Nextcloud Talk, mattermost-plugin-voice-message
- [x] Библиотеки: вес/лицензия/живость/вердикт
- [x] Грабли
- [x] Доступность
- [ ] Библиотеки: opus-recorder, extendable-media-recorder, wavesurfer.js, RecordRTC,
      audio-recorder-polyfill — вес, лицензия, последний релиз, нужны ли
- [ ] Живые чаты: Element (есть), Nextcloud Talk (есть), нужен третий (Mattermost/Rocket.Chat/Chatwoot)
- [ ] Грабли: localhost secure context, отказ в доступе, фон вкладки, duration=Infinity,
      индикатор микрофона, обрыв
- [ ] Доступность: длительность/скачивание/транскрипция
