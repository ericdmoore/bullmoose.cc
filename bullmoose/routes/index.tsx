import { asset } from "$fresh/runtime.ts";

export default function Home() {
  return (
    <div class="px-4 py-8 mx-auto bg-slate-50">
      <div class="max-w-screen-md mx-auto flex flex-col items-center justify-center">
        <h1 class="text-4xl  font-serif">bullmoose.cc</h1>
        <img src={asset('/walkright.svg')} />
      </div>
    </div>
  );
}
