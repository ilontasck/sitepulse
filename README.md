# Website Audit SaaS · SitePulse / NOQORI

Начните здесь. Репозиторий — `sitepulse`, текущий интерфейс — **NOQORI**; переименование не выполнялось.

**Актуальная рабочая ветка:** `integration/beta-readiness-2026-09-25`. Она включает STE-31 и последующие квоты, историю, админские операции и основу email. `main` пока старее. Это кандидат для закрытой беты, а не разрешение на запуск.

## Запуск на своём компьютере

Нужны Node.js **24.x** (`.node-version`: 24.14.0) и pnpm **11.9.0**.

```sh
pnpm install --frozen-lockfile
```

Создайте `.env` из `.env.example`, **только если своего `.env` ещё нет**. Для локальной тестовой регистрации пример содержит `AUTH_REGISTRATION_MODE=public`. В двух терминалах из одной папки:

```sh
pnpm start
pnpm worker
```

Откройте `http://127.0.0.1:3000`, зарегистрируйте тестовый аккаунт и запустите аудит публичного URL. API и worker должны использовать одну версию кода и одну SQLite-базу. Подробнее: [локальный запуск и проверки](docs/LOCAL-DEVELOPMENT.md).

## Что читать дальше

- [Точное состояние Git, выбранная база и результаты проверок](docs/SOURCE-OF-TRUTH.md)
- [Что мешает закрытой бете и публичному запуску](docs/BETA-READINESS.md)
- [Контракт хранения и удаления STE-31](docs/RETENTION-DELETION.md)
- [Безопасность и границы проверки](docs/SECURITY-REVIEW.md)
- [Реквизиты и юридическая готовность](docs/LEGAL_READINESS.md)
- [Linux: процессы](docs/PRODUCTION_PROCESS_SUPERVISION.md), [изоляция сети](docs/PRODUCTION_BROWSER_SECURITY.md), [наблюдаемость](docs/PRODUCTION-OBSERVABILITY.md)
- [Устройство приложения и API](docs/APPLICATION.md)

Приложение рассчитано на Mac, Windows и Linux с Node 24. В этой проверке использован **только Mac**. Production-профиль требует **Linux, systemd и network namespace/nftables**; Mac и Windows его не заменяют. Не запускайте сервис для внешних пользователей в development-режиме ради обхода проверок.

Реальные `.env`, SQLite, клиентские отчёты и приватные архивы остаются вне Git. Не сбрасывайте базу ради тестов: тесты используют отдельные временные данные. Исторические документы в `docs/history/` не являются текущим статусом.
