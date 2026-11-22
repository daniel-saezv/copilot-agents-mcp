# copilot-agents-mcp

Servidor MCP remoto para lanzar y seguir agentes de GitHub Copilot en la nube desde cualquier cliente MCP.

Se apoya en la API REST de agent tasks de GitHub (`/agents/...`, versión `2026-03-10`, en public preview).

## Estado

En construcción. Todavía no hay código: este repositorio solo contiene la configuración para agentes, este README y la licencia.

## Qué hará el incremento 1

- Lanzar una tarea de Copilot en un repositorio, eligiendo el modelo. El modelo se pasa tal cual a la API.
- Listar los modelos disponibles a partir de una fuente real, no de una tabla en el código. Para cada uno da el nombre exacto que acepta la API, el multiplicador de premium requests y otros datos útiles para elegir.
- Consultar el estado de una tarea.
- Avisar cuando la tarea llega a un estado final (`completed`, `failed`, `timed_out`, `cancelled` o `idle`). El aviso es un POST a una URL que se configura como secreto.
- Si GitHub rechaza un modelo, devolver un error claro con la lista de modelos que ya se han visto aceptados.

## Límites de la API de GitHub

- No hay endpoint para cancelar una tarea. Se cancela el run de Actions del agente.
- No se puede responder dentro de una sesión en curso. Cada seguimiento es una tarea nueva sobre la misma rama (`head_ref`).
- No hay webhook de fin de sesión.
- El nivel de razonamiento no se puede elegir al lanzar una tarea.

## Credenciales

- Hace falta un token de GitHub con el permiso «Agent tasks: read and write» en los repositorios donde se lancen tareas.
- Los tokens se guardan como secretos del entorno de despliegue. Nunca se escriben en el repositorio, en los logs ni en un chat.

## Referencias

- [Agent tasks REST API](https://docs.github.com/en/rest/agent-tasks/agent-tasks)
- [github/github-mcp-server](https://github.com/github/github-mcp-server), el MCP oficial cuyos estándares se siguen.
- [fvegiard/copilot-cloud-agent-mcp](https://github.com/fvegiard/copilot-cloud-agent-mcp), un repositorio archivado con licencia MIT que se usa solo como referencia. Si se copia código suyo, se mantiene su aviso de copyright.

## Desarrollo con agentes

Las reglas para agentes están en `AGENTS.md` y las skills en `.agents/skills/`. Copilot lee las mismas reglas a través de `.github/copilot-instructions.md`.

En Windows, activa `git config --global core.symlinks true` antes de clonar. Sin esa opción, los enlaces simbólicos de `.claude/skills/` y `.github/copilot-instructions.md` se guardan como archivos de texto.

## Licencia

[MIT](LICENSE).
