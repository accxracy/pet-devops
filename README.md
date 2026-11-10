# Pet DevOps

Учебный DevOps-проект: развёртывание Node.js-приложения с PostgreSQL и Redis в Kubernetes, автоматизация доставки через GitLab CI/CD и наблюдаемость с Prometheus, Grafana и Alertmanager.

Цель проекта: на практике изучить полный жизненный цикл приложения: контейнеризацию, подготовку локальной инфраструктуры, доставку изменений, настройку доступа, мониторинг, алертинг, резервное копирование и диагностику неисправностей.

> **Статус:** учебная среда, не production-ready. Наличие манифестов и шаблонов не означает, что все сценарии восстановления и отказоустойчивости испытаны.

## О приложении и моей работе

Node.js-приложение создано с помощью Claude и служит тестовой рабочей нагрузкой для инфраструктуры. Мой основной фокус: Docker, Kubernetes, Helm, Terraform, GitLab CI/CD, GitLab Agent, RBAC и мониторинг.

## Архитектура

```text
GitLab CI/CD
  |
  +-- build: Docker image -> GitLab Container Registry (commit SHA)
  |
  +-- monitoring: Helm -> kube-prometheus-stack
  |
  +-- deploy: Helm -> Node.js / PostgreSQL / Redis
  |             через Kubernetes-контекст GitLab Agent
  |
  +-- test: HTTP smoke test -> /healthz/ready

Локальный kind-кластер (Terraform, 1 control-plane + 2 worker)
  |
  +-- namespace pet-app
  |     +-- Node.js Deployment -> PostgreSQL StatefulSet
  |     |                       -> Redis
  |     +-- Ingress / Service
  |     +-- ServiceMonitor -> /metrics
  |     +-- PrometheusRule -> PetAppDown
  |     +-- CronJob pg-dump -> PVC postgres-backups
  |     +-- ConfigMap: Grafana dashboard JSON
  |
  +-- namespace monitoring
        +-- Prometheus (scrape метрик приложения)
        +-- Grafana (дашборд, sidecar для ConfigMap)
        +-- Alertmanager (уведомления -> Telegram)
```

Приложение и стек мониторинга разворачиваются отдельными Helm-релизами. GitLab Runner исполняет CI jobs, а GitLab Agent обеспечивает доступ к Kubernetes API через настроенный контекст. Права этого доступа регулируются Kubernetes RBAC.

## Технологии

| Область | Инструменты |
| --- | --- |
| Приложение и данные | Node.js, PostgreSQL, Redis |
| Контейнеризация | Docker, GitLab Container Registry |
| Оркестрация | Kubernetes (kind), Helm, NGINX Ingress |
| Infrastructure as Code | Terraform (`kind` provider) |
| CI/CD | GitLab CI/CD, GitLab Runner, GitLab Agent for Kubernetes |
| Безопасность и доступ | Kubernetes RBAC, ServiceAccount, Kubernetes Secrets, GitLab CI/CD variables |
| Мониторинг и алертинг | Prometheus, Grafana, Alertmanager, kube-prometheus-stack, ServiceMonitor, PrometheusRule |
| Резервное копирование | Kubernetes CronJob, `pg_dump`, `pg_restore`, PVC |

## Что реализовано в репозитории

### Инфраструктура и приложение

- **Terraform** описывает локальный kind-кластер с одной control-plane- и двумя worker-нодами (`IaC/main.tf`).
- **Docker** используется для контейнеризации Node.js-приложения.
- **Helm** описывает приложение, PostgreSQL, Redis, сервисы, Ingress, ServiceMonitor, PrometheusRule, CronJob и ConfigMap дашборда.
- **PostgreSQL** запускается как StatefulSet с постоянным хранилищем; Redis используется приложением как отдельный сервис.
- **RBAC** описан в `IaC/rbac.yaml` для доступа CI/Agent к ресурсам кластера и namespace.

### GitLab CI/CD

Пайплайн в `.gitlab-ci.yml` состоит из четырёх стадий:

```text
build -> monitoring -> deploy -> test
```

1. **build** — сборка Docker-образа и публикация в GitLab Container Registry с тегом `$CI_COMMIT_SHA`.
2. **monitoring** — установка или обновление `kube-prometheus-stack` с помощью Helm.
3. **deploy** — обновление Helm-релиза приложения, ожидание готовности Deployment и проверка фактического тега образа.
4. **test** — HTTP smoke test endpoint `/healthz/ready` из временного Pod внутри кластера.

Для работы с кластером используется Kubernetes-контекст GitLab Agent. Jobs для Kubernetes ограничены основной веткой проекта. Мониторинг устанавливается перед приложением, чтобы CRD для ServiceMonitor и PrometheusRule были доступны к моменту деплоя.

Для обновления Helm-релизов используются `--atomic` и `--timeout 5m`. При неудачном обновлении Helm автоматически откатывает релиз к предыдущей успешной ревизии. Для первоначальной установки мониторинга используется `helm upgrade --install`.

> **Нюанс:** текущая команда для приложения — `helm upgrade` (без `--install`). Это предполагает, что первоначальная установка релиза уже выполнена. Автоматический rollback Helm не заменяет проверку работоспособности приложения и полноценную стратегию восстановления после сбоев.

### Мониторинг

- Приложение экспортирует метрики на `/metrics`.
- `ServiceMonitor` задаёт обнаружение endpoint приложения для Prometheus.
- Grafana отображает HTTP RPS, CPU usage, Node.js heap memory, uptime; запрос для панели error rate ещё требует проверки.
- JSON дашборда находится в `helm/charts/pet-app/dashboards/dashboard.json`.
- Helm-шаблон `dashboard.yaml` создаёт ConfigMap с меткой `grafana_dashboard: "1"`.
- В `helm/monitoring/values.yaml` включён Grafana dashboard sidecar, который ищет ConfigMap с этой меткой во всех namespace (`searchNamespace: ALL`).
- Для Grafana предусмотрен PVC; логин и пароль администратора передаются из GitLab CI/CD variables.

**Статус автоматической загрузки дашборда:** конфигурация ConfigMap + sidecar уже реализована. Корректную загрузку дашборда после чистого развёртывания следует проверять отдельно в работающем кластере.

### Alertmanager

Для обработки алертов и отправки уведомлений в Telegram используется **Alertmanager**.

- **PrometheusRule** содержит правило `PetAppDown`, которое срабатывает, если Prometheus фиксирует неуспешный сбор метрик приложения в течение 2 минут.
- **Alertmanager** группирует алерты и отправляет уведомления через Telegram-бота, включая сообщения о восстановлении (`send_resolved: true`).
- Конфигурация хранится в `helm/monitoring/values.yaml`, токен бота передаётся через переменную GitLab CI/CD `TELEGRAM_BOT_API`.
- Доставка уведомлений проверена с помощью временного тестового правила `vector(1)`.

Текущее правило `PetAppDown` использует метрику `up == 0`. Обнаружение полного исчезновения target из Prometheus требует дополнительной проверки.

### Резервное копирование PostgreSQL

- В Helm-чарте создан Kubernetes CronJob `pg-dump`.
- Расписание по умолчанию: `0 3 * * 1` — по понедельникам в 03:00.
- CronJob выполняет `pg_dump --format=custom` и проверяет, что архив читается командой `pg_restore --list`.
- Файл сначала записывается с суффиксом `.partial`, затем переименовывается после успешного завершения.
- Дампы хранятся на PVC `postgres-backups` размером 2 GiB в namespace `pet-app`.
- Пароль PostgreSQL считывается из Kubernetes Secret, а ServiceAccount token не монтируется в контейнер CronJob.

**Ограничения:** бэкапы пока хранятся на PVC в локальном кластере, а не во внешнем независимом хранилище. `pg_restore --list` проверяет структуру архива, но не заменяет тестовое восстановление и проверку данных. Автоматизированная процедура восстановления и контроль сохранности копий за пределами кластера пока не представлены.

## Структура репозитория

```text
.
├── .gitlab/agents/       # конфигурация GitLab Agent
├── .gitlab-ci.yml        # CI/CD pipeline
├── IaC/                  # Terraform и RBAC
├── app/                  # Node.js приложение
├── backup/               # PVC для бэкапов
├── helm/
│   ├── charts/pet-app/   # Helm-чарт приложения и сервисов
│   └── monitoring/       # значения для kube-prometheus-stack
├── Dockerfile
└── README.md
```

## Быстрые проверки после развёртывания

Команды ниже предполагают настроенный `kubectl`-контекст для локального кластера и уже установленные Helm-релизы.

```bash
kubectl get nodes
kubectl get pods,svc,pvc -n pet-app
kubectl get pods,pvc -n monitoring
helm status pet-app -n pet-app
helm status monitoring -n monitoring
```

Проверка бэкапного CronJob и его запусков:

```bash
kubectl get cronjob pg-dump -n pet-app
kubectl get jobs -n pet-app
kubectl get pvc postgres-backups -n pet-app
```

Проверка ConfigMap дашборда:

```bash
kubectl get configmaps -n pet-app -l grafana_dashboard=1
```

Проверка правил алертинга и состояния Alertmanager:

```bash
kubectl get prometheusrules -n pet-app
kubectl get alertmanagers -n monitoring
```

Проверка прав Kubernetes требует указания соответствующего ServiceAccount и namespace; манифесты расположены в `IaC/rbac.yaml`.

## Ограничения и технический долг

- **Локальное окружение:** доступность kind-кластера зависит от компьютера и Docker.
- **Хранение данных:** локальные PVC не заменяют внешние резервные копии.
- **Disaster recovery:** регулярный тест восстановления PostgreSQL из бэкапа ещё не описан и не автоматизирован.
- **CI/CD:** `--atomic` обеспечивает откат неуспешного Helm upgrade, но не гарантирует восстановление данных или корректность приложения после успешного деплоя.
- **Секреты мониторинга:** Telegram-токен передаётся через Helm CLI; требуется исключить его сохранение в метаданных Helm-релиза.
- **Безопасность:** инфраструктура учебная; перед переносом в production понадобятся дополнительные меры по управлению секретами, политике сетевого доступа, обновлениям и доступности.

## Roadmap

- [x] Контейнеризировать Node.js-приложение
- [x] Добавить PostgreSQL и Redis
- [x] Описать локальный kind-кластер через Terraform
- [x] Создать Helm-чарт приложения
- [x] Настроить GitLab CI/CD и публикацию образов
- [x] Подключить GitLab Agent к кластеру
- [x] Добавить readiness smoke test после деплоя
- [x] Развернуть Prometheus и Grafana
- [x] Добавить ServiceMonitor и дашборд
- [x] Добавить Helm ConfigMap дашборда и Grafana sidecar
- [x] Описать RBAC для GitLab Agent / CI
- [x] Добавить CronJob для `pg_dump` на PVC
- [x] Настроить Alertmanager, правила алертов и уведомления
- [x] Добавить автоматический rollback Helm при неудачном upgrade

## Назначение проекта

Это практический полигон для освоения DevOps: важно не только развернуть работающий стек, но и уметь объяснить поток деплоя, диагностировать сетевые и Kubernetes-сбои, проверять мониторинг и восстанавливать работоспособность инфраструктуры.