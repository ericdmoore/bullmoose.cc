import { asset } from "$fresh/runtime.ts";
import { FreshContext, Handlers } from "$fresh/server.ts";


export const handler: Handlers = {
  GET: async (_req: Request, ctx: FreshContext) =>{
    const resp = await ctx.render();
    resp.headers.set("DevMsg", "Let me know if you see any issues with this site. eric at bullmoose.cc");
    return resp;
  },
};


export default function Home() {
  return (
    <div class="px-4 py-8 mx-auto bg-slate-50">
      <div class="max-w-screen-md mx-auto flex flex-col items-center justify-center">
        <h1 class="text-4xl  font-serif">bullmoose.cc</h1>
        <img height="500rem" src={asset('/walkright.svg')} />
      </div>
    </div>
  );
}
