# AGENTS.md

## Reglas transversales

1. Demuestra que funciona antes de darlo por hecho: comando real, test o captura.
2. Arregla la causa raíz, no el síntoma.
3. Resta antes de sumar: borra código muerto antes de añadir.
4. Haz el cambio mínimo que resuelve, sin capas ni abstracciones especulativas.
5. Los tests prueban comportamiento observable, no la implementación.
6. Amplía un test existente antes de crear otro y borra los que dejen de aplicar.
7. Sin comentarios en el código: que el nombre y la estructura lo expliquen.
8. Validación y manejo de errores en los bordes del sistema, no repartidos por todo el código.
9. Operaciones idempotentes: se pueden repetir sin daño.
10. Una unidad verificable por commit o PR.
11. Antes de reportar un número, explícalo y mídelo bien.
12. Si una corrección se repite, conviértela en estructura (test, lint, tipo) y no en otra instrucción.
13. Nunca inventes comandos, stack ni datos: solo lo comprobado.
14. Sin ficheros `.md` largos de planes o decisiones; el porqué va en la PR o en el commit.
15. Prosa breve y sin relleno en PRs, commits y documentación.
16. No cambies alcance, diseño ni prioridades por tu cuenta; si algo te bloquea, dilo con exactitud.
17. La preparación del entorno vive en `scripts/setup`. Es idempotente. Los archivos de cada proveedor de agentes en la nube solo lo invocan. Si cambias dependencias, toolchain o pasos de arranque, actualiza el script y comprueba que esos envoltorios siguen funcionando. Si el proyecto usa un proveedor sin envoltorio, créalo.

## Mantenimiento de skills

Hay dos clases:

1. **Instaladas desde pstack** (inglés, instalador oficial): `blast-radius`, `correct`, `principle-prove-it-works`, `tdd` y `unslop`. Se añaden o actualizan con el CLI [`skills`](https://github.com/vercel-labs/skills), por ejemplo:

   ```bash
   npx skills add cursor/plugins --skill tdd -a cursor -a github-copilot -a codex -a gemini-cli -a claude-code -y
   ```

   Esas skills pueden nombrar otras de pstack que no vienen en la plantilla (por ejemplo, `blast-radius` menciona `why` y `arena`). Si las necesitas, instálalas con `npx skills add cursor/plugins --skill <nombre>` o con `/add-plugin pstack` en Cursor.

2. **Propias de la plantilla** (español): `setup-proyecto`, `entorno-agentes`, `pr-lista`, `technical-writing` y `how`. Viven solo en este repositorio; para que Claude Code las vea, mantén los enlaces en `.claude/skills/` apuntando a `.agents/skills/<nombre>`.

Para actualizar las skills bloqueadas en `skills-lock.json`:

```bash
npx skills update -y
```

Revisa el diff, valida con `npx skills check` y commitea `.agents/skills/`, `.claude/skills/` y `skills-lock.json`.

### Créditos de skills de pstack

Skills de [pstack](https://github.com/cursor/plugins/tree/main/pstack) por Lauren Tan (licencia MIT), instaladas con el instalador oficial. Las adaptaciones en español `how` y `technical-writing` derivan del mismo origen; ver `.agents/skills/LICENSE`.

## Este proyecto

Servidor MCP local para lanzar agentes de GitHub Copilot en la nube, leer el estado de una tarea, avisar al terminar y consultar los precios oficiales de los modelos. No hay despliegue ni servicio en la nube: se arranca en la máquina con `npx -y github:daniel-saezv/copilot-agents-mcp`.

### Stack

Node.js 22.23.4 (el paquete pide `>=22.18`) y npm 10.9.9. En desarrollo, Node ejecuta `src/cli.ts` con type stripping. Node no quita tipos dentro de `node_modules`, así que `prepare` compila a `dist/` con `tsc -p tsconfig.build.json` y el bin de npm es `dist/cli.js`. Dependencias de producción: `@modelcontextprotocol/sdk` 1.32.2, `zod` 4.6.7, `ajv` 8, `ajv-formats` 3 y `yaml` 2. Tests con Vitest 5.1.1. Lint con ESLint 9 y `typescript-eslint`. Tipos con `tsc --noEmit`.

### Estructura

- `src/cli.ts` arranca stdio, HTTP o el subcomando `watch`.
- `src/server.ts` registra las herramientas. `src/http.ts` escucha en `127.0.0.1`. `src/selection.ts` aplica toolsets y cabeceras `X-MCP-*`.
- `src/github.ts` llama a la API de agent tasks con `X-GitHub-Api-Version: 2026-03-10` y valida la respuesta con el OpenAPI oficial.
- `src/pricing.ts` lee la tabla y las notas de github/docs en cada llamada.
- `src/state.ts`, `src/watch.ts` y `src/notify.ts` guardan el estado local y avisan una vez.
- `fixtures/` trae los ejemplos del OpenAPI y la página de precios. `src/__toolsnaps__/` fija `tools/list`.

### Comandos comprobados

```bash
bash scripts/setup
npm test
npm run typecheck
npm run lint
npm run licenses
npm audit --audit-level=low
npm run build
node src/cli.ts
node dist/cli.js --help
node src/cli.ts --http --port 3333
```

`bash scripts/setup` se ejecutó dos veces seguidas y salió 0 las dos. Hace `npm ci`, y `prepare` compila `dist/`. La segunda pasada de tests dejó 24 tests en 5 archivos. `npm run typecheck` y `npm run lint` salieron 0. `npm run licenses` aceptó 93 paquetes de producción. `npm audit --audit-level=low` encontró 0 vulnerabilidades. `npm run build` salió 0 y `node dist/cli.js --help` escribió la ayuda. `node src/cli.ts` respondió a `tools/list` por stdio y `node src/cli.ts --http --port 3333` escuchó en `http://127.0.0.1:3333/mcp` y respondió lo mismo.

### Buenas prácticas de este stack

Los imports relativos llevan extensión `.ts`. El esquema de cada herramienta lleva `additionalProperties: false`. Las respuestas de GitHub se validan en el cliente, antes de usarlas. El token solo entra por el entorno. `npm audit --audit-level=low` y el chequeo de licencias forman parte del CI. Zod 4.6.7 y Vitest 5.1.1 están en ese rango porque las versiones anteriores arrastraban avisos de `npm audit`.

### CI/CD

Workflows en cada pull request y en cada push a `main`:

- `.github/workflows/ci.yml`: `npm ci`, tipos, lint, tests, `npm audit --audit-level=low`, licencias y CodeQL (`javascript-typescript`). Las actions están fijadas por SHA.
- `.github/workflows/skills.yml`: comprueba el lock de skills. Node 22.20.
- `.github/workflows/copilot-setup-steps.yml`: ejecuta `bash scripts/setup` si cambia ese script o el workflow.

La API de protección de rama respondió 403, así que no consta aquí si algún check es obligatorio. Los workflows de arriba se ejecutan en cada PR. Conviene exigir los jobs `test` y `codeql` de `ci.yml` antes del merge si aún no lo están. El proyecto no se despliega y no se publica en npm. La distribución es `npx` desde este repositorio de GitHub.

## Cursor Cloud specific instructions

`.cursor/environment.json` solo llama a `bash scripts/setup`. No hay `start`: el servidor por defecto se queda en stdio.

Para probar: `npm test`, `npm run typecheck` y `npm run lint`. Para ver las herramientas, `node src/cli.ts` por stdio o `node src/cli.ts --http --port 3333` y el cliente en `http://127.0.0.1:3333/mcp`.

Secretos que se pueden añadir en Cursor, sin valor aquí: `GITHUB_PERSONAL_ACCESS_TOKEN` (hace falta para lanzar o leer una tarea real; no hace falta para el CI, para `tools/list` ni para los precios), `COPILOT_AGENTS_NOTIFY_URL` y `COPILOT_AGENTS_NOTIFY_AUTHORIZATION`.
