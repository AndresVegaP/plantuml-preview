# Modelo de seguridad

Este documento existe para que un equipo de seguridad pueda evaluar la extensión sin
leer todo el código. Describe qué se considera no confiable, qué garantiza el diseño y
dónde está implementada cada garantía.

## Premisa

**Un archivo `.puml` es entrada no confiable.** Puede venir de un repositorio de un
tercero, de un adjunto o de una plantilla generada. El lenguaje PlantUML no es
declarativo e inofensivo: incluye un preprocesador con `!include`, `!includeurl`,
`%load_json` y carga de sprites remotos. Una vista previa ingenua convierte «abrí un
diagrama» en «leí archivos arbitrarios de tu disco» o «hice peticiones a Internet en tu
nombre».

Por eso el diseño parte de asumir que el diagrama es hostil.

## Superficie de ataque y mitigaciones

### 1. Ejecución de código desde el diagrama

| Vector | Mitigación | Dónde |
|---|---|---|
| `<script>` incrustado en el SVG generado | Elemento eliminado con su subárbol; además la CSP no permite scripts sin *nonce* | `src/shared/svgSanitizer.ts`, `src/extension/preview/webviewHtml.ts` |
| Atributos `on*` (incluidos los que aún no existen) | Rechazados **por forma del nombre**, no por lista | `svgSanitizer.ts` |
| `<foreignObject>` con HTML o `<iframe>` | Subárbol eliminado por completo | `svgSanitizer.ts` |
| `<animate attributeName="href">` reapuntando un atributo ya saneado | Elementos de animación eliminados | `svgSanitizer.ts` |
| `javascript:` en un `href`, incluso ofuscado con entidades o saltos de línea | El valor se **decodifica antes** de validarlo y se eliminan espacios y caracteres de control | `svgSanitizer.ts` |

### 2. Salida de datos a la red (SSRF y exfiltración)

La defensa principal **no** es una lista de bloqueo, sino la política de seguridad de
contenido del webview:

```
default-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none';
base-uri 'none'; form-action 'none';
img-src <recursos de la extensión> data:;
script-src <recursos de la extensión> 'nonce-…' 'wasm-unsafe-eval';
style-src  <recursos de la extensión> 'unsafe-inline';
```

Consecuencias:

- El motor PlantUML implementa `!includeurl` y los sprites remotos con
  `XMLHttpRequest`. Con `connect-src 'none'`, **el navegador rechaza esas peticiones**.
  No hay que confiar en que el motor se porte bien.
- Ninguna imagen, fuente, hoja de estilo ni script puede venir de fuera del paquete de
  la extensión.
- `'unsafe-inline'` en `style-src` es necesario porque PlantUML aplica estilos con
  `setAttribute('style', …)`. Es seguro aquí precisamente porque **ningún origen está
  permitido para ninguna carga**: el CSS no puede llamar a casa cuando toda petición ya
  está denegada.
- `'wasm-unsafe-eval'` permite instanciar el módulo WebAssembly de Graphviz. No permite
  `eval` ni `new Function`; se verificó que el motor no usa ninguno de los dos.

Adicionalmente, el resolvedor de includes del host **nunca descarga** un `!includeurl`:
lo sustituye por un comentario y lo reporta en el panel de Problemas.

### 3. Lectura de archivos arbitrarios

El motor predeterminado se ejecuta en el webview, que **no tiene acceso al sistema de
archivos**. Los `!include` los resuelve el host antes de renderizar y los envía como
texto. Ese resolvedor aplica:

- **confinamiento de rutas**: solo la carpeta del documento, la carpeta del espacio de
  trabajo y las de `plantuml.include.paths`. La comparación usa rutas resueltas con
  separador final, de modo que `/srcx` no cuenta como dentro de `/src`;
- **detección de ciclos** por pila de inclusión activa;
- **límite de profundidad** (`plantuml.include.maxDepth`, 10 por defecto);
- **límite de tamaño total** (8 MB) del texto insertado;
- **neutralización** de la ruta rechazada antes de devolverla como comentario, para que
  no se pueda inyectar sintaxis PlantUML por ahí.

Salir de esos límites requiere activar explícitamente
`plantuml.include.allowOutsideWorkspace`.

### 4. Ejecución de procesos

Solo ocurre con el backend `jar`, que no es el predeterminado. Cuando se usa:

- se lanza con `spawn` y un **array de argumentos**, nunca con shell, así que comillas,
  `&&` o backticks en una ruta o en un ajuste son datos, no sintaxis;
- PlantUML corre con `PLANTUML_SECURITY_PROFILE=ALLOWLIST` y
  `-Dplantuml.allowlist.path=<carpetas permitidas>`, lo que bloquea las URL y limita la
  lectura de archivos;
- se añade `-DPLANTUML_LIMIT_SIZE` para acotar el tamaño de imagen;
- el diagrama llega por *stdin*, no por un archivo temporal, así que no hay ruta
  predecible que otro proceso pueda interceptar;
- hay tiempo límite, muerte del proceso al agotarse y tope de bytes de salida.

### 5. Envío del diagrama a un servidor

Solo con el backend `server`, que tampoco es el predeterminado. `validateServerUrl`
rechaza:

- cualquier host que no sea *loopback*, salvo que se active
  `plantuml.render.allowRemoteServer`;
- esquemas distintos de `http` y `https`;
- credenciales incrustadas en la URL.

El cliente HTTP **no sigue redirecciones**: una redirección es justamente el mecanismo
por el que una URL local aparentemente inocente acabaría enviando el diagrama a otro
sitio.

### 6. El webview como fuente no confiable

El host trata al webview como no confiable, porque en él se ejecuta código de terceros
sobre entrada controlada por un atacante. Cada mensaje entrante pasa por
`parseWebviewMessage`, que valida tipo, forma y cotas de tamaño, y rechaza lo
desconocido. Los datos de exportación deben ser base64 estricto antes de tocar
`Buffer`. El estado serializado que sobrevive a un reinicio se valida igual.

### 7. Confianza del espacio de trabajo

En una carpeta no confiable, `readConfiguration` fuerza el backend `javascript` e
ignora `jarPath`, `javaPath`, `serverUrl`, `jvmArguments` e `include.paths`. Es decir,
abrir un repositorio ajeno no puede hacer que la extensión lance un programa que ese
repositorio eligió.

## Cadena de suministro

- **Cero dependencias de runtime.** `npm audit --omit=dev` y `npm audit` completo
  reportan 0 vulnerabilidades.
- El motor `@plantuml/core` se copia al paquete en tiempo de compilación y su
  **SHA-256 queda registrado** en `media/engine/MANIFEST.json`. `npm run verify`
  comprueba que los bytes empaquetados coinciden.
- El script de copia **rechaza** cualquier versión del motor cuya licencia no sea MIT,
  para que una actualización no reintroduzca GPL sin que nadie lo note.
- `.npmrc` fija `ignore-scripts=true`, así que ningún paquete transitivo ejecuta código
  durante la instalación.
- La extensión **no tiene telemetría**. El único destino de sus datos es el canal de
  salida local.

## Cómo verificarlo usted mismo

```bash
npm audit                 # 0 vulnerabilidades, incluido dev
npm run verify            # licencias, checksums, CSP y postura de red
npm run test:unit         # 167 pruebas, incluidas 39 de saneado de SVG
npm run test:integration  # 18 pruebas dentro de una instancia real de VS Code
npm run harness           # inspección visual del render y el saneado en un navegador
grep -rn "fetch\|XMLHttpRequest\|WebSocket" src/   # sin llamadas de red ad hoc
```

## Reportar un problema

Esta es una extensión de construcción propia; no hay un canal público. Trate cualquier
hallazgo por el proceso interno de su organización y corrija el código en su copia.
