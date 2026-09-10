# Lingua Technis Acoustic Modem — flat Vercel build

Version: **1.2.0-data-spacing-diagnostics**

Все файлы лежат в корне репозитория — папка `src` не нужна.

## Что изменено в этой версии

- preamble сохранён без изменений: `2700 → 1700 → 1200 → 2700 → 1700 → 1200 Hz`;
- marker tone = 50 ms, marker gap = 24 ms;
- data tones остаются `1200 / 1700 / 2200 / 2700 Hz`;
- после старта кадра RX больше не пытается распознавать preamble внутри payload;
- SELF-TEST теперь показывает этапы PASS/FAIL;
- добавлен лог последних распознанных тонов и progress marker;
- CRC16 теперь защищает `length + payload`;
- UI показывает реальный размер JSON payload в байтах и блокирует слишком большой пакет;
- reset RX также сбрасывает progress preamble.

## Обновление через GitHub с телефона

Можно заменить все файлы из этого архива. Для текущего патча критически изменён `App.jsx`; `package.json` изменён только номером версии, README — документацией.

После commit Vercel должен автоматически запустить новый deployment. На странице проверь строку версии под заголовком: `1.2.0-data-spacing-diagnostics`.

## Проверка

1. Открой deployment по HTTPS.
2. Включи RX, если он выключен.
3. Поставь чувствительность примерно 1–3/5 для первого теста.
4. Нажми `Реальный self-test`.
5. Смотри `SELF-TEST DIAGNOSTICS`, `Marker: x/6` и `Последние распознанные тоны`.

Успех — статус `PASS` и сообщение `SELF-TEST PASS` в журнале. Если будет `FAIL`, скрин панели диагностики покажет конкретный этап, на котором остановился RX.


## v1.2 patch

- Preamble unchanged: `2700 → 1700 → 1200 → 2700 → 1700 → 1200`.
- DATA timing slowed from `24 ms + 12 ms` to `40 ms tone + 24 ms gap` for cleaner acoustic separation on the Fold.
- Self-test timeout increased to 5 seconds after TX.
- RX diagnostics now show received/expected symbol and byte counters.
- Self-test diagnostics preserve the expected TX frame size so missing symbols are visible even when RX never completes CRC.
