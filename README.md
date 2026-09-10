# PlantUML Preview

Vista previa en vivo de diagramas PlantUML dentro de VS Code, igual que la vista previa de Markdown.

**Funciona completamente sin conexión: no necesita Java, ni Graphviz, ni un servidor.**

Esta extensión está pensada para entornos corporativos donde solo se pueden instalar
extensiones propias o aprobadas: se construye desde este código fuente, se empaqueta en
un `.vsix` local y se puede auditar por completo.

---

## Por qué existe

| Requisito | Cómo se cumple |
|---|---|
| Licencia de código abierto | MIT, incluido el motor de renderizado ([`@plantuml/core`](https://www.npmjs.com/package/@plantuml/core), MIT desde 1.2026.6) |
| Sin vulnerabilidades | `npm audit` limpio, **cero dependencias de runtime** |
| Sin instalar nada externo | El motor PlantUML va compilado a JavaScript/WebAssembly dentro del paquete |
| Que nada salga de la máquina | El renderizado ocurre dentro del editor; la red está bloqueada por CSP |
| Auditable | ~4.000 líneas propias, tipadas en modo estricto, con 167 pruebas unitarias |

```
$ npm audit
found 0 vulnerabilities
```

---

## Instalación

Necesita Node.js 20 o superior. No necesita Java.

```bash
npm install
npm run vendor
npm run compile
npm run package
```

Esto genera `plantuml-preview.vsix`. Para instalarlo:

```bash
code --install-extension plantuml-preview.vsix
```

También puede instalarlo desde la interfaz: **Extensiones → menú `...` → Install from VSIX...**

Antes de instalar, si quiere revisar qué contiene el paquete:

```bash
npm run verify
```

---

## Uso

| Acción | Atajo | Comando |
|---|---|---|
| Abrir vista previa al lado | `Ctrl+K V` | `PlantUML: Open Preview to the Side` |
| Abrir vista previa | `Ctrl+Shift+V` | `PlantUML: Open Preview` |
| Fijar la vista previa a un archivo | — | `PlantUML: Open Locked Preview to the Side` |
| Elegir diagrama en un archivo con varios | — | `PlantUML: Select Diagram in File` |
| Exportar a SVG o PNG | — | `PlantUML: Export Diagram...` |
| Volver al código fuente | doble clic en la vista previa | `PlantUML: Show Source` |

También aparece un icono de vista previa en la barra del editor, igual que en Markdown.
`Alt`+clic sobre ese icono abre la vista previa en la misma columna en vez de al lado.

**Dentro de la vista previa:** `Ctrl`+rueda para hacer zoom, arrastrar para desplazar,
`+` / `-` / `Ctrl+0` con el teclado, y el botón **Fit** para ajustar a la ventana.

### Archivos con varios diagramas

Un archivo puede contener varios bloques `@startuml … @enduml`. Por defecto la vista
previa sigue al cursor: mueva el cursor a otro bloque y la vista previa cambia. Con
`PlantUML: Select Diagram in File` puede fijar uno concreto.

### `!include`

Los diagramas repartidos en varios archivos funcionan. La extensión resuelve
`!include`, `!include_once`, `!includesub` y `!includedef` **ella misma**, antes de
renderizar, de modo que:

- funcionan también con el motor JavaScript, que no tiene acceso al disco;
- solo se leen archivos dentro del espacio de trabajo o de las carpetas listadas en
  `plantuml.include.paths`;
- los includes remotos (`!includeurl`, o una URL) **nunca se descargan**, y se avisa
  de ello en el panel de Problemas.

---

## Motores de renderizado

La extensión trae tres backends. El primero es el predeterminado y no requiere nada.

### 1. `javascript` (predeterminado, recomendado)

PlantUML compilado a JavaScript con [TeaVM](https://teavm.org/) más Graphviz compilado a
WebAssembly, ejecutándose dentro del webview de la vista previa. Sin Java, sin procesos
externos, sin red. Es el mismo motor que usa el editor oficial de plantuml.com.

### 2. `jar` (opcional, máxima fidelidad)

Ejecuta un `plantuml.jar` local con Java. Útil si necesita alguna característica que el
motor JavaScript aún no cubre, o si su organización exige una versión concreta.

```bash
# Descarga verificada por checksum desde Maven Central (variante MIT por defecto)
npm run fetch:plantuml
```

El script imprime la ruta que debe poner en `plantuml.render.jarPath`. Acepta
`--license=mit|asl|lgpl|epl|gpl` y `--version=...`. El JAR se guarda en `vendor/`, que
queda fuera del `.vsix` y fuera de git.

Cuando se usa este backend, PlantUML se ejecuta con
`PLANTUML_SECURITY_PROFILE=ALLOWLIST` y una lista explícita de carpetas legibles, sin
shell, con el diagrama enviado por *stdin* y con tiempo límite.

### 3. `server` (opcional, requiere consentimiento explícito)

Llama a un servidor PlantUML por HTTP, por ejemplo uno propio en Docker:

```bash
docker run -d -p 8080:8080 plantuml/plantuml-server:jetty
```

```jsonc
"plantuml.render.backend": "server",
"plantuml.render.serverUrl": "http://localhost:8080"
```

> **El texto del diagrama se envía a ese servidor.** Por eso la extensión **rechaza**
> cualquier URL que no sea local salvo que active `plantuml.render.allowRemoteServer`.
> Tampoco sigue redirecciones ni acepta credenciales dentro de la URL.

---

## Configuración

| Ajuste | Predeterminado | Qué hace |
|---|---|---|
| `plantuml.render.backend` | `javascript` | Motor de renderizado |
| `plantuml.render.timeoutMs` | `20000` | Límite de tiempo por render |
| `plantuml.render.jarPath` | `""` | Ruta a `plantuml.jar` (backend `jar`) |
| `plantuml.render.javaPath` | `""` | Ruta a `java`; si está vacío usa `JAVA_HOME` y luego `PATH` |
| `plantuml.render.serverUrl` | `""` | URL del servidor (backend `server`) |
| `plantuml.render.allowRemoteServer` | `false` | Permite un servidor fuera de esta máquina |
| `plantuml.preview.updateMode` | `live` | `live`, `onSave` o `manual` |
| `plantuml.preview.debounceMs` | `400` | Pausa antes de re-renderizar al escribir |
| `plantuml.preview.theme` | `auto` | `auto`, `light` o `dark` |
| `plantuml.preview.scrollPreviewWithEditor` | `true` | La vista previa sigue al cursor |
| `plantuml.preview.doubleClickToSource` | `true` | Doble clic vuelve al código |
| `plantuml.include.enabled` | `true` | Resolver `!include` |
| `plantuml.include.paths` | `[]` | Carpetas adicionales de búsqueda |
| `plantuml.include.allowOutsideWorkspace` | `false` | Permite leer fuera del espacio de trabajo |
| `plantuml.export.format` | `svg` | Formato predeterminado de exportación |
| `plantuml.export.pngScale` | `2` | Densidad de píxeles al exportar a PNG |
| `plantuml.diagnostics.enabled` | `true` | Errores de sintaxis en el panel de Problemas |

---

## Seguridad

Un archivo `.puml` es entrada no confiable: puede venir de un repositorio ajeno. El
diseño parte de esa premisa. El detalle completo está en [SECURITY.md](SECURITY.md);
en resumen:

- **La red está cerrada por CSP.** El webview declara `connect-src 'none'`, así que las
  peticiones que PlantUML haría por `!includeurl` o por sprites remotos fallan en el
  navegador. No hay SSRF ni exfiltración posible desde un diagrama.
- **Todo SVG se sanea antes de tocar el DOM**, con listas de permitidos y política de
  *fallo cerrado*: lo que no se entiende, se rechaza en vez de mostrarse.
- **Los `!include` están confinados** al espacio de trabajo, con límite de profundidad,
  detección de ciclos y tope de tamaño.
- **Sin telemetría.** Ningún dato sale de la máquina, nunca.
- **Respeta la confianza del espacio de trabajo**: en una carpeta no confiable solo se
  permite el motor JavaScript, nunca lanzar un proceso ni abrir un socket.
- **Cero dependencias de runtime**, así que no hay árbol de terceros que auditar.

---

## Desarrollo

```bash
npm install          # dependencias de desarrollo
npm run vendor       # copia el motor PlantUML a media/engine (con SHA-256)
npm run compile      # compila host de extensión y webview
npm run lint         # ESLint en modo estricto con información de tipos
npm run test:unit    # 167 pruebas unitarias, sin VS Code
npm run test:integration  # pruebas dentro de una instancia real de VS Code
npm run harness      # inspección visual en un navegador (manual)
npm run package      # genera el .vsix
npm run verify       # audita el paquete construido
```

Pulse `F5` en VS Code para lanzar una ventana de desarrollo con la extensión cargada.

La arquitectura está documentada en [docs/architecture.md](docs/architecture.md).

---

## Licencias de terceros

| Componente | Licencia |
|---|---|
| Esta extensión | MIT |
| [`@plantuml/core`](https://www.npmjs.com/package/@plantuml/core) (motor incluido) | MIT |
| [Viz.js](https://github.com/mdaines/viz-js) / Graphviz (incluido en el motor) | MIT / EPL-1.0 |
| `plantuml.jar` (opcional, no incluido) | la que elija al descargarlo: MIT, Apache, LGPL, EPL o GPL |

El texto de la licencia del motor se copia en `media/engine/LICENSE` durante la
compilación.
