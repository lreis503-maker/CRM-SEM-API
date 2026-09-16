export const metadata = {
  title: "Política de Privacidade",
};

export default function PrivacyPolicyPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16 text-foreground">
      <h1 className="text-3xl font-bold tracking-tight">Política de Privacidade</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Última atualização: 16 de setembro de 2026
      </p>

      <div className="mt-8 space-y-8 text-sm leading-relaxed text-foreground/90">
        <section>
          <h2 className="text-lg font-semibold text-foreground">1. Quem somos</h2>
          <p className="mt-2">
            Esta aplicação é um CRM (Customer Relationship Management) auto-hospedado,
            usado para centralizar o atendimento ao cliente via WhatsApp e Instagram
            Direct em uma caixa de entrada compartilhada. O operador desta instância é
            responsável pelo tratamento dos dados descritos nesta política.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-foreground">2. Quais dados coletamos</h2>
          <p className="mt-2">Ao usar esta aplicação, podemos processar:</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>
              Dados de contato fornecidos por clientes que iniciam uma conversa via
              WhatsApp ou Instagram Direct (nome, número de telefone, nome de usuário e
              identificador de perfil, quando aplicável).
            </li>
            <li>
              O conteúdo das mensagens trocadas (texto, imagens, áudios, vídeos e
              documentos) e metadados associados, como horário de envio e status de
              entrega/leitura.
            </li>
            <li>
              Dados de conta de usuários da equipe que operam o CRM (nome, e-mail e
              função de acesso).
            </li>
            <li>
              Informações comerciais inseridas manualmente na plataforma, como etiquetas,
              notas, negócios em funis de venda e campos personalizados de contato.
            </li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-foreground">3. Como usamos esses dados</h2>
          <p className="mt-2">Os dados coletados são usados exclusivamente para:</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>Exibir e organizar conversas em uma caixa de entrada compartilhada entre atendentes.</li>
            <li>Permitir que a equipe responda a mensagens recebidas pelo WhatsApp e pelo Instagram Direct.</li>
            <li>Manter o histórico de relacionamento com o contato (funil de vendas, notas, etiquetas).</li>
            <li>
              Quando ativado pelo operador, gerar sugestões de resposta ou automatizar
              respostas com um provedor de IA (OpenAI ou Anthropic) configurado pelo
              próprio operador com sua chave de API.
            </li>
            <li>Cumprir obrigações legais e de segurança da própria aplicação.</li>
          </ul>
          <p className="mt-2">
            Não vendemos, alugamos ou compartilhamos dados de contatos com terceiros
            para fins de publicidade.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-foreground">4. Integração com Meta (WhatsApp e Instagram)</h2>
          <p className="mt-2">
            Esta aplicação se conecta às APIs oficiais da Meta (WhatsApp Business Platform
            e Instagram Messaging API) para enviar e receber mensagens em nome da conta
            comercial do operador. O acesso é feito por meio de tokens de acesso
            fornecidos pelo próprio operador, armazenados de forma criptografada
            (AES-256-GCM) e nunca expostos publicamente.
          </p>
          <p className="mt-2">
            Mídia recebida (imagens, áudios, vídeos e documentos) é copiada para um
            armazenamento próprio e seguro, pois os links de mídia fornecidos pela Meta
            expiram após um período determinado pela plataforma.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-foreground">5. Armazenamento e segurança</h2>
          <p className="mt-2">
            Os dados são armazenados em um banco de dados PostgreSQL gerenciado (Supabase),
            protegido por controle de acesso em nível de linha (Row Level Security) que
            garante que cada conta só acesse seus próprios dados. Tokens de acesso e
            segredos são criptografados antes de serem gravados no banco de dados.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-foreground">6. Retenção de dados</h2>
          <p className="mt-2">
            Os dados são mantidos enquanto a conta estiver ativa ou conforme necessário
            para cumprir finalidades legítimas de negócio. Um contato, conversa ou mensagem
            pode ser excluído a pedido do titular dos dados, sujeito às limitações técnicas
            e legais aplicáveis.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-foreground">7. Direitos do titular dos dados</h2>
          <p className="mt-2">
            Qualquer pessoa cujos dados sejam processados por esta aplicação pode solicitar
            acesso, correção ou exclusão de suas informações entrando em contato com o
            operador da conta responsável pelo atendimento.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-foreground">8. Contato</h2>
          <p className="mt-2">
            Dúvidas sobre esta política podem ser enviadas para o e-mail de contato
            informado pelo operador desta instância nas configurações da conta.
          </p>
        </section>
      </div>
    </main>
  );
}
