/**
 * Smoke test: prueba conexión a la cola FIFO de Ajax sin borrar mensajes.
 *
 * Uso:
 *   npx tsx scripts/test-sqs-peek.ts
 *
 * Hace ReceiveMessage con visibility timeout MUY corto (2s) para no afectar
 * la cola productiva. NO llama DeleteMessage — los mensajes vuelven a estar
 * disponibles para el consumer real.
 *
 * Además consulta GetQueueAttributes para ver cuántos mensajes hay encolados.
 */
import 'dotenv/config';
import {
  SQSClient,
  ReceiveMessageCommand,
  GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';

async function main(): Promise<void> {
  const url = process.env.SQS_URL;
  if (!url) {
    console.error('❌ SQS_URL no definida en .env');
    process.exit(1);
  }

  const client = new SQSClient({
    region: process.env.AWS_REGION ?? 'eu-central-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '',
    },
  });

  console.log('📦 SQS smoke test');
  console.log(`Region : ${process.env.AWS_REGION}`);
  console.log(`Queue  : ${url.replace(/\/\d{12}\//, '/***/')}`);
  console.log('');

  // 1) Atributos de la cola
  try {
    const attrs = await client.send(
      new GetQueueAttributesCommand({
        QueueUrl: url,
        AttributeNames: [
          'ApproximateNumberOfMessages',
          'ApproximateNumberOfMessagesNotVisible',
          'ApproximateNumberOfMessagesDelayed',
          'FifoQueue',
        ],
      }),
    );
    console.log('Atributos de la cola:');
    console.log(`  Mensajes visibles    : ${attrs.Attributes?.ApproximateNumberOfMessages ?? '?'}`);
    console.log(`  Mensajes en proceso  : ${attrs.Attributes?.ApproximateNumberOfMessagesNotVisible ?? '?'}`);
    console.log(`  Mensajes diferidos   : ${attrs.Attributes?.ApproximateNumberOfMessagesDelayed ?? '?'}`);
    console.log(`  Es FIFO              : ${attrs.Attributes?.FifoQueue ?? 'false'}`);
    console.log('');
  } catch (err) {
    console.error('❌ GetQueueAttributes falló:', (err as Error).message);
    process.exit(1);
  }

  // 2) Peek (visibility 2s, sin borrar)
  console.log('Haciendo ReceiveMessage (peek, no borrar)...');
  const res = await client.send(
    new ReceiveMessageCommand({
      QueueUrl: url,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 5, // long polling corto
      VisibilityTimeout: 2, // mensaje vuelve enseguida
      AttributeNames: ['All'],
      MessageAttributeNames: ['All'],
    }),
  );

  const msgs = res.Messages ?? [];
  if (msgs.length === 0) {
    console.log('ℹ️  No hay mensajes para inspeccionar (la cola está vacía o todos están en proceso).');
    console.log('   La conexión funcionó correctamente.');
    return;
  }

  for (const m of msgs) {
    console.log('---');
    console.log(`MessageId      : ${m.MessageId}`);
    console.log(`MessageGroupId : ${m.Attributes?.MessageGroupId ?? '(none)'}`);
    console.log(`Body bytes     : ${m.Body?.length ?? 0}`);
    // No imprimimos el body completo por seguridad (puede contener PII)
    try {
      const parsed = JSON.parse(m.Body ?? '{}');
      const summary = {
        keys: Object.keys(parsed).slice(0, 10),
        eventCode: parsed.eventCode ?? parsed.code ?? parsed.cid ?? parsed.sia,
        hubId: parsed.hubId ?? parsed.objectId,
        timestamp: parsed.timestamp ?? parsed.occurredAt,
      };
      console.log('Resumen body   :', summary);
    } catch {
      console.log('Body no es JSON válido');
    }
  }
  console.log('---');
  console.log('✅ Conexión a SQS OK. Mensajes NO fueron borrados.');
}

main().catch((err) => {
  console.error('Fallo:', err.message);
  process.exit(1);
});
