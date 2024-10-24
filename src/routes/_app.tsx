import { type PageProps } from "$fresh/server.ts";
import { asset } from "$fresh/runtime.ts";

export default function App({ Component }: PageProps) {
  return (
    <html>
      <head>
        <meta charset="utf-8" />
        <title>bullmoose.cc</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <link rel="icon" href={asset("/stripped_favicon.svg" )}/>
        <link rel="stylesheet" href="/styles.css" />
      </head>
      <body class=" bg-slate-50">
        <Component />
      </body>
    </html>
  );
}