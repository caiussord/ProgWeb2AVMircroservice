import amqplib from 'amqplib';
import retry from 'async-retry';

export async function createChannel(url, exchange) {
  const connection = await retry(async (bail, attempt) => {
    try {
      console.log(`[AMQP] Tentativa ${attempt} de conexão...`);
      const conn = await amqplib.connect(url);
      console.log('[AMQP] Conectado com sucesso!');
      return conn;
    } catch (err) {
      console.error(`[AMQP] Falha na tentativa ${attempt}:`, err.message);
      throw err; 
    }
  }, {
    retries: 5,        
    factor: 2,          
    minTimeout: 1000,  
    onRetry: (err, attempt) => {
      console.log(`[AMQP] Tentando novamente... (tentativa ${attempt})`);
    }
  });

  const ch = await connection.createChannel();
  await ch.assertExchange(exchange, 'topic', { durable: true });
  return { conn: connection, ch };
}