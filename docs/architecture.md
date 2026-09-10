# Arquitectura

## Idea central

El renderizado ocurre **dentro del webview de la vista previa**, no en el proceso de la
extensión.

Es una decisión poco habitual y es la que hace posible todo lo demás. PlantUML está
escrito en Java; `@plantuml/core` es esa misma base compilada a JavaScript con TeaVM,
junto con Graphviz compilado a WebAssembly. Ese motor construye el SVG con
`document.createElementNS`, así que **necesita un DOM** y no puede ejecutarse en Node.
El webview es un DOM disponible, aislado y ya sometido a una política de seguridad de
contenido.

Las consecuencias son directas:

- no hace falta Java, ni Graphviz, ni un servidor;
- el motor no tiene acceso al sistema de archivos, así que no puede filtrar archivos;
- la CSP del webview bloquea la red, así que el motor no puede hacer peticiones;
- el proceso de la extensión no ejecuta nada de terceros.

El precio es que el host debe preparar el texto completo antes de enviarlo, lo que
motiva el resolvedor de `!include` propio.

## Capas

```
src/
├── shared/        sin dependencias de vscode: se compila para AMBOS lados
│   ├── diagram.ts        análisis de bloques @startuml…@enduml
│   ├── svgSanitizer.ts   saneado de SVG con fallo cerrado
│   ├── protocol.ts       tipos de mensajes + validación
│   ├── serverUrl.ts      ¿puede salir el diagrama de esta máquina?
│   ├── result.ts         Result<T, E>
│   ├── async.ts          Debouncer, LatestOnlyQueue
│   ├── lru.ts            caché con presupuesto de bytes
│   └── disposable.ts     DisposableStore
│
├── extension/     proceso de la extensión (CommonJS → out/)
│   ├── extension.ts      raíz de composición: aquí se construye todo
│   ├── config.ts         lectura y validación de ajustes + confianza
│   ├── diagnostics.ts    panel de Problemas
│   ├── logger.ts         LogOutputChannel
│   ├── commands/         comandos, delgados
│   ├── include/          resolvedor de !include con confinamiento
│   ├── preview/          panel, gestor de paneles, HTML + CSP
│   └── render/           backends jar y server, codificador, errores
│
└── webview/       dentro del iframe (ES modules → media/dist/)
    ├── main.ts           orquestación: mensajes, saneado, estados
    ├── engine.ts         envoltorio tipado de @plantuml/core
    └── viewer.ts         zoom, desplazamiento y ajuste
```

`shared/` se compila dos veces, una por cada `tsconfig`. Es la única duplicación del
proyecto y compra algo valioso: el protocolo y el saneador son literalmente el mismo
código en ambos extremos, así que no pueden divergir sin romper la compilación.

## Flujo de un render

```
  documento cambia
        │
        ▼
  Debouncer (400 ms)  ──►  LatestOnlyQueue  (descarta peticiones intermedias)
        │
        ▼
  parseDiagrams()          ¿qué bloques hay en el archivo?
        │
        ▼
  pickBlock()              el fijado, o el que contiene el cursor
        │
        ▼
  RenderCoordinator.prepare()
        │  resuelve !include, construye el mapa de líneas
        ▼
   ┌────────────────────────┬──────────────────────────┐
   │ backend "javascript"   │ backend "jar" / "server" │
   ▼                        ▼                          │
  postMessage(render)      HostRenderer.render()       │
   │                        │                          │
   │  el webview renderiza  │  el host obtiene el SVG  │
   │  con @plantuml/core    │                          │
   │                        ▼                          │
   │                     postMessage(setContent)       │
   └────────────┬───────────┘                          │
                ▼                                      │
          sanitiseSvg()   ◄── único camino al DOM ─────┘
                │
                ▼
          DOMParser (image/svg+xml)  ── nunca innerHTML
                │
                ▼
          Viewer.setContent()  +  postMessage(rendered)
                                        │
                                        ▼
                                 diagnósticos al host
```

Dos detalles que evitan errores sutiles:

- **Tokens de correlación.** Cada petición lleva un número creciente. Una respuesta con
  un token viejo se descarta, así que un render lento no puede pisar a uno más reciente.
- **`LatestOnlyQueue`.** Si llegan tres peticiones mientras una está en curso, la del
  medio se descarta: su resultado se iba a tirar igualmente, y descartarla mantiene la
  latencia acotada por *un* render en vez de por la longitud de la cola.

## Mapa de líneas

Insertar un `!include` desplaza todas las líneas siguientes. Sin corregirlo, un error
del renderizador en «la línea 42» subrayaría el sitio equivocado.

El resolvedor devuelve, además del texto, un `lineMap` donde `lineMap[i]` es la línea
original que produjo la línea `i` del texto expandido. Las líneas que vienen de un
archivo incluido se atribuyen a la directiva `!include` que las trajo, que es lo más
cercano a un sitio útil dentro del archivo que el usuario está editando.

Ese mismo mapa se usa en la dirección contraria: PlantUML estampa `data-source-line` en
cada grupo SVG, así que un doble clic en una forma lleva el cursor a la línea exacta que
la generó.

## Ciclo de vida de una vista previa

Modelado sobre la vista previa de Markdown de VS Code, que es el comportamiento que la
gente ya conoce:

- una vista previa está anclada a un **URI**, no a un editor abierto, así que cerrar la
  pestaña del código no la rompe;
- una vista previa **no fijada** se reapunta al archivo PlantUML que pase a estar
  activo; una **fijada** se queda donde está y su título pasa a `[Preview] archivo`;
- se reutiliza como máximo una vista previa no fijada por grupo de editores; las
  redundantes se cierran solas;
- un `WebviewPanelSerializer` la restaura tras recargar la ventana, validando el estado
  guardado como si fuera un mensaje cualquiera.

`retainContextWhenHidden` está activado a propósito. Normalmente conviene evitarlo, pero
aquí el webview contiene un motor de varios megabytes cuyo arranque cuesta cerca de un
segundo; reconstruirlo cada vez que se cambia de pestaña haría que la vista previa
pareciera rota.

## Decisiones de herramientas

- **Sin bundler.** Como no hay dependencias de runtime, `tsc` basta. Elimina esbuild o
  webpack —y sus binarios nativos— de la superficie a auditar.
- **Sin Mocha.** El árbol de dependencias de `@vscode/test-cli` arrastra avisos
  publicados. Las pruebas unitarias usan el runner integrado de Node y las de
  integración un arnés propio de unas cincuenta líneas sobre `@vscode/test-electron`.
- **TypeScript en modo estricto máximo**, incluidos `noUncheckedIndexedAccess` y
  `exactOptionalPropertyTypes`. Ambos encontraron defectos reales durante el desarrollo.
- **ESLint con información de tipos** (`strictTypeChecked`), sobre todo por
  `no-floating-promises`: en una extensión, un `await` olvidado se traga el error.
