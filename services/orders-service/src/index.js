import express from 'express';
import morgan from 'morgan';
import retry from 'async-retry';
import CircuitBreaker from 'opossum';
import swaggerUi from 'swagger-ui-express';
import swaggerJsdoc from 'swagger-jsdoc';
import { PrismaClient } from '@prisma/client';
import { createChannel } from './amqp.js';
import { ROUTING_KEYS } from '../../../common/events.js';

export const app = express();
app.use(express.json());
const prisma = new PrismaClient();
app.use(morgan('dev'));

const swaggerOptions = {
    definition: {
        openapi: '3.0.0',
        info: {
            title: 'Orders Service API',
            version: '1.0.0',
            description: 'API para gestão de pedidos',
        },
    components: {
      schemas: {
        OrderItem: {
          type: 'object',
          properties: {
            sku: { type: 'string', example: 'BOOK-123' },
            qty: { type: 'integer', example: 2 },
          }
        },
        OrderInput: {
          type: 'object',
          properties: {
            userId: { type: 'string' },
            items: { type: 'array', items: { $ref: '#/components/schemas/OrderItem' } },
            total: { type: 'number', example: 120.50 },
          },
          required: ['userId', 'items', 'total']
        },
        Order: {
          allOf: [
            {
              type: 'object',
              properties: {
                id: { type: 'string' },
                status: { type: 'string', example: 'created' },
                createdAt: { type: 'string', format: 'date-time' },
              },
            },
            { $ref: '#/components/schemas/OrderInput' },
          ],
        },
      },
    },
    },
    apis: ['./src/index.js'],
};
const swaggerDocs = swaggerJsdoc(swaggerOptions);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocs));

const PORT = process.env.PORT || 3002;
const USERS_BASE_URL = process.env.USERS_BASE_URL || 'http://localhost:3001';
const HTTP_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 2000);
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';
const EXCHANGE = process.env.EXCHANGE || 'app.topic';
const QUEUE = process.env.QUEUE || 'orders.q';
const ROUTING_KEY_USER_CREATED = process.env.ROUTING_KEY_USER_CREATED || ROUTING_KEYS.USER_CREATED;

const userCache = new Map();

const circuitBreakerOptions = {
  timeout: 3000, // 3 segundo pra timeout
  errorThresholdPercentage: 50, // Caso metade das requisições falhem ira abirir o circuito
  resetTimeout: 30000 // 30 pra tentativa de fechar o circuito
};

// vai assegurar que a função fetchWithTimeout é definida antes de ser usada
const breaker = new CircuitBreaker(async (userId) => {
  return fetchWithTimeout(`${USERS_BASE_URL}/${userId}`, HTTP_TIMEOUT_MS);
}, circuitBreakerOptions);

// Fallback para CB
// Circuito aberto -> usar cache
breaker.fallback(async (userId) => {
  console.warn('[CircuitBreaker] Circuito aberto. Fallback para cache de utilizadores.');
  if (userCache.has(userId)) {
    // Simulação de resposta HTTP
    return { ok: true, status: 200, fromCache: true };
  }
  // Se não estiver no cache, simula falha
  throw new Error('Serviço de utilizadores indisponível e utilizador não encontrado no cache');
});

let amqp = null;
if (!process.env.JEST_WORKER_ID) {
  (async () => {
    try {
      amqp = await createChannel(RABBITMQ_URL, EXCHANGE);
      console.log('[orders] AMQP connected');

      // Bind de fila para consumir eventos user.created
      await amqp.ch.assertQueue(QUEUE, { durable: true });
      await amqp.ch.bindQueue(QUEUE, EXCHANGE, ROUTING_KEY_USER_CREATED);

      amqp.ch.consume(QUEUE, msg => {
        if (!msg) return;
        try {
          const user = JSON.parse(msg.content.toString());
          // idempotência simples: atualiza/define
          userCache.set(user.id, user);
          console.log('[orders] consumed event user.created -> cached', user.id);
          amqp.ch.ack(msg);
        } catch (err) {
          console.error('[orders] consume error:', err.message);
          amqp.ch.nack(msg, false, false); // descarta em caso de erro de parsing (aula: discutir DLQ)
        }
      });
    } catch (err) {
      console.error('[orders] AMQP connection failed:', err.message);
    }
  })();
}

export async function getOrders(req, res) {
  const ordersFromDb = await prisma.order.findMany();
  const orders = ordersFromDb.map(order => ({
    ...order,
    items: JSON.parse(order.items),
  }));
  res.json(orders);
}

export async function createOrder(req, res) {
  const { userId, items, total } = req.body || {};
  if (!userId || !Array.isArray(items) || typeof total !== 'number') {
    return res.status(400).json({ error: 'userId, items[], total<number> são obrigatórios' });
  }

  try {
    // Usa o breaker em vez da chamada direta
    const resp = await breaker.fire(userId);
    if (!resp.ok) return res.status(400).json({ error: 'usuário inválido' });
  } catch (err) {
    console.error('[createOrder] Erro ao validar utilizador:', err.message);
    return res.status(503).json({ error: err.message });
  }

  const orderData = await prisma.order.create({
    data: {
      userId,
      items: JSON.stringify(items), // Persist as string
      total,
    },
  });

  const order = {
    ...orderData,
    items: JSON.parse(orderData.items), // Convert back for client
  };

  // (Opcional) publicar evento order.created
  try {
    if (amqp?.ch) {
      amqp.ch.publish(
        EXCHANGE,
        ROUTING_KEYS.ORDER_CREATED,
        Buffer.from(JSON.stringify(order)),
        { persistent: true }
      );
      console.log('[orders] published event:', ROUTING_KEYS.ORDER_CREATED, order.id);
    }
  } catch (err) {
    console.error('[orders] publish error:', err.message);
  }

  res.status(201).json(order);
}

//Order cancel
export async function cancelOrder(req, res) {
  try {
    const cancelledOrderData = await prisma.order.update({
      where: { id: req.params.id },
      data: { status: 'cancelled' },
    });

    const cancelledOrder = {
      ...cancelledOrderData,
      items: JSON.parse(cancelledOrderData.items), // Conversao para resposta cliente
    };

    // Publish event order
    try {
      if (amqp?.ch) {
        const payload = Buffer.from(JSON.stringify(cancelledOrder));
        amqp.ch.publish(EXCHANGE, ROUTING_KEYS.ORDER_CANCELLED, payload, { persistent: true });
        console.log('[orders] published event:', ROUTING_KEYS.ORDER_CANCELLED, cancelledOrder.id);
      }
    } catch (err) {
      console.error('[orders] publish error:', err.message);
    }
    res.json(cancelledOrder);
  } catch (error) {
    res.status(404).json({ error: 'order not found' });
  }
}

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

/**
 * @swagger
 * /:
 *   get:
 *     summary: Get all 
 *     responses:
 *       '200':
 *         description: Lista pedidos.
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Order'
 *   post:
 *     summary: Novo pedido.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/OrderInput'
 *     responses:
 *       '201':
 *         description: Pedido criado com sucesso.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Order'
 *       '400':
 *         description: Dados inválidos ou user inválido.
 *       '503':
 *         description: Serviço de user indisponível.
 */
app.get('/', getOrders);
app.post('/', createOrder);

/**
 * @swagger
 * /{id}/cancel:
 *   patch:
 *     summary: Cancelamento de pedido
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: O ID do pedido a ser cancelado
 *     responses:
 *       '200':
 *         description: Pedido cancelado com sucesso.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Order'
 *       '404':
 *         description: Pedido não encontrado.
 */
app.patch('/:id/cancel', cancelOrder);


if (!process.env.JEST_WORKER_ID && process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`[orders] listening on http://localhost:${PORT}`);
  });
}