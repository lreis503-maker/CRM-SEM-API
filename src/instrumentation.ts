/**
 * Ponto de partida do servidor, chamado uma vez pelo Next quando o
 * processo sobe.
 *
 * Só serve para ligar o agendador do monitor de contas de anúncio. Se
 * outro recurso precisar de inicialização no futuro, ele entra aqui —
 * o Next só chama um `register` por aplicação.
 *
 * Referência:
 * node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md
 */
export async function register(): Promise<void> {
  // `register` roda também no runtime Edge e durante a compilação. O
  // agendador precisa de Node (temporizadores longos, cliente
  // Supabase com service role), então sai fora nos outros casos.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;

  const { startAdMonitorScheduler } = await import('@/lib/ads/scheduler');

  if (startAdMonitorScheduler()) {
    console.info(
      '[ads-monitor] verificação automática ligada, uma vez por hora',
    );
  }
}
