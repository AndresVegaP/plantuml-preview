# Changelog

## 1.0.1

### Corregido

- Con un editor en tema oscuro, los diagramas que definen sus propios colores claros
  (por ejemplo `skinparam class { BackgroundColor #FDFDFD }`) se veían con texto blanco
  sobre cajas blancas. El modo oscuro de PlantUML cambia el texto a blanco pero respeta
  los colores fijados en el diagrama. `plantuml.preview.theme` pasa a ser `light` por
  defecto, de modo que el diagrama se muestra tal como se diseñó y se exporta; `auto` y
  `dark` siguen disponibles para diagramas sin colores propios.
- La exportación a PNG en modo oscuro usa el mismo fondo que dibuja PlantUML (`#1B1B1B`).

### Añadido

- Ejemplo `samples/database-model.puml`: modelo entidad-relación de una tienda en línea.

## 1.0.0

Primera versión.

### Vista previa

- Vista previa en vivo de diagramas PlantUML, con el mismo modelo de interacción que la
  vista previa de Markdown de VS Code: icono en la barra del editor, `Ctrl+K V` para
  abrir al lado, vistas previas fijadas, y restauración tras recargar la ventana.
- Renderizado totalmente sin conexión con el motor PlantUML compilado a JavaScript
  (`@plantuml/core`, MIT). No requiere Java, Graphviz ni servidor.
- Zoom, desplazamiento y ajuste a la ventana, con teclado y con ratón.
- Archivos con varios diagramas: la vista previa sigue al cursor, o se puede fijar un
  diagrama concreto.
- Doble clic sobre una forma lleva el cursor a la línea exacta que la generó.
- Exportación a SVG y PNG.
- Modo claro y oscuro, siguiendo el tema del editor.

### Lenguaje

- Contribución del lenguaje `plantuml` para `.puml`, `.plantuml`, `.pu`, `.iuml`,
  `.wsd` y `.pml`, con gramática TextMate, comentarios, plegado e indentación.
- Errores de sintaxis y problemas de `!include` en el panel de Problemas, en la línea
  correcta incluso cuando hay inclusiones.

### Includes

- Resolución propia de `!include`, `!include_once`, `!include_many`, `!includesub` y
  `!includedef`, con selectores `archivo!seccion` y `archivo!indice`.
- Confinamiento al espacio de trabajo, detección de ciclos, límite de profundidad y de
  tamaño.
- Los archivos incluidos se vigilan: al editarlos, la vista previa se actualiza.

### Backends opcionales

- `jar`: `plantuml.jar` local, ejecutado con perfil de seguridad restringido, sin shell
  y con tiempo límite. Script de descarga verificada por checksum desde Maven Central,
  con elección de licencia.
- `server`: servidor PlantUML por HTTP, restringido a *loopback* salvo consentimiento
  explícito, sin seguir redirecciones.

### Seguridad y cadena de suministro

- Cero dependencias de runtime; `npm audit` limpio.
- Saneado de SVG con listas de permitidos y fallo cerrado antes de tocar el DOM.
- CSP que bloquea toda la red desde el webview, incluidas las peticiones que PlantUML
  haría por `!includeurl`.
- Respeta la confianza del espacio de trabajo.
- Sin telemetría.
