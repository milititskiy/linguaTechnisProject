# Lingua Technis Acoustic Modem — flat Vercel build

Version: **1.4.0-diagnostic-export**

Все файлы лежат в корне репозитория — папка `src` не нужна.

## Главное изменение v1.4

После обнаружения preamble RX больше не ищет паузы между каждым DATA-тоном. Он синхронизируется по первому DATA-тону и затем читает ровно один символ каждые 64 ms. Для каждого символа анализируется центральное 24-ms окно внутри 40-ms тона. Это делает DATA RX значительно менее зависимым от акустического хвоста и эха телефона.

- Preamble: `2700 → 1700 → 1200 → 2700 → 1700 → 1200 Hz` — без изменений.
- DATA: `40 ms tone + 24 ms gap` — без изменений.
- DATA RX: clocked/synchronous Goertzel.
- Для каждого символа используется majority vote из 3 подокон плюс полный Goertzel-window как fallback.
- После старта DATA threshold больше не используется для разделения символов.
- `1/5` — стартовое значение порога поиска preamble.
- Self-test статистика показывает PASS/FAIL rate.
- После CRC-valid приёма сохраняется отдельный LAST CRC-VALID RX snapshot.
- CRC16 защищает `length + payload`.

## Обновление через GitHub с телефона

Загрузи все файлы поверх существующих и сделай Commit. Vercel должен автоматически создать новый deployment.

Под заголовком приложения проверь версию: `1.3.0-clocked-rx`.

## Проверка

1. Открой Vercel deployment по HTTPS.
2. Включи RX.
3. Оставь `Порог поиска preamble` на 1/5.
4. Запусти `Реальный self-test` несколько раз подряд.
5. Смотри PASS/FAIL, Symbols/Bytes и LAST CRC-VALID RX.

Цель v1.4 — собирать машиночитаемый diagnostic log каждого self-test, чтобы анализировать конкретные ошибочные символы и CRC без скриншотов.


## Экспорт diagnostic logs

После каждого self-test лог автоматически сохраняется в браузере (до 12 последних запусков). В панели SELF-TEST есть кнопки:

- `Экспорт последнего лога (.json)` — один последний тест.
- `Экспорт всех логов` — архив до 12 последних тестов.

JSON содержит версию приложения, user agent, sample rate, mic settings, AUDIO_CONFIG, ожидаемый TX frame/symbols, каждый фактически распознанный DATA symbol, Goertzel energies по 1200/1700/2200/2700 Hz, confidence, vote, mismatches, confusion matrix, RX frame hex и обе CRC. Этот JSON можно загрузить прямо в ChatGPT для разбора.
