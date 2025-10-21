import express from 'express';
import morgan from 'morgan';
import swaggerUi from 'swagger-ui-express';
import swaggerJsdoc from 'swagger-jsdoc';
import { PrismaClient } from '@prisma/client';
import { createChannel } from './amqp.js';
import { ROUTING_KEYS } from '../../../common/events.js';

export const app = express();
const prisma = new PrismaClient();
app.use(express.json());
app.use(morgan('dev'));

const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Users Service API',
      version: '1.0.0',
      description: 'API para gestão de utilizadores',
    },
    components: {
      schemas: {
        UserInput: {
          type: 'object',
          properties: {
            name: { type: 'string', example: 'Caius Sordi' },
            email: { type: 'string', example: 'caius.sordi@example.com' },
          },
        },
        User: {
          allOf: [
            {
              type: 'object',
              properties: {
                id: { type: 'string' },
                createdAt: { type: 'string', format: 'date-time' },
              },
            },
            { $ref: '#/components/schemas/UserInput' },
          ],
        },
      },
    },
  },
  apis: ['./src/index.js'],
};
const swaggerDocs = swaggerJsdoc(swaggerOptions);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocs));


const PORT = process.env.PORT || 3001;
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';
const EXCHANGE = process.env.EXCHANGE || 'app.topic';


let amqp = null;
if (!process.env.JEST_WORKER_ID) {
  (async () => {
    try {
      amqp = await createChannel(RABBITMQ_URL, EXCHANGE);
      console.log('[users] AMQP connected');
    } catch (err) {
      console.error('[users] AMQP connection failed:', err.message);
    }
  })();
}

const getAllUsers = async (req, res) => {
  const users = await prisma.user.findMany();
  res.json(users);
};

const createUser = async (req, res) => {
  const { name, email } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: 'name and email are required' });

  try {
    const user = await prisma.user.create({
      data: { name, email },
    });

    // Publish event
    try {
      if (amqp?.ch) {
        const payload = Buffer.from(JSON.stringify(user));
        amqp.ch.publish(EXCHANGE, ROUTING_KEYS.USER_CREATED, payload, { persistent: true });
        console.log('[users] published event:', ROUTING_KEYS.USER_CREATED, user.id);
      }
    } catch (err) {
      console.error('[users] publish error:', err.message);
    }

    res.status(201).json(user);
  } catch (error) {
    // erro de e-mail duplicado
    if (error.code === 'P2002') {
      return res.status(409).json({ error: 'email ja existe' });
    }
    res.status(500).json({ error: 'something went wrong' });
  }
};

const getUserById = async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.params.id },
  });
  if (!user) return res.status(404).json({ error: 'not found' });
  res.json(user);
};

const updateUser = async (req, res) => {
  const { name, email } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: 'name and email are required' });

  try {
    const updatedUser = await prisma.user.update({
      where: { id: req.params.id },
      data: { name, email },
    });

    // Publish event update
    try {
      if (amqp?.ch) {
        const payload = Buffer.from(JSON.stringify(updatedUser));
        amqp.ch.publish(EXCHANGE, ROUTING_KEYS.USER_UPDATED, payload, { persistent: true });
        console.log('[users] published event:', ROUTING_KEYS.USER_UPDATED, updatedUser.id);
      }
    } catch (err) {
      console.error('[users] publish error:', err.message);
    }

    res.json(updatedUser);
  } catch (error) {
    // erro de utilizador não encontrado ou e-mail duplicado
    res.status(404).json({ error: 'user not found or invalid data' });
  }
};

app.get('/health', (req, res) => res.json({ ok: true, service: 'users' }));

/**
 * @swagger
 * /:
 *   get:
 *     summary: Get all
 *     responses:
 *       '200':
 *         description: Lista de user.
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/User'
 *   post:
 *     summary: Novo user
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UserInput'
 *     responses:
 *       '201':
 *         description: User criado com sucesso.
 *       '400':
 *         description: Nome e e-mail são obrigatórios.
 *       '409':
 *         description: O e-mail já existe.
 */
app.route('/')
  .get(getAllUsers)
  .post(createUser);

/**
 * @swagger
 * /{id}:
 *   get:
 *     summary: Get user by ID
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: O ID do user
 *     responses:
 *       '200':
 *         description: Os dados do user.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 *       '404':
 *         description: Utilizador não encontrado.
 *   put:
 *     summary: Atualiza um user existente
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: O ID do user a ser atualizado
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UserInput'
 *     responses:
 *       '200':
 *         description: User atualizado com sucesso.
 *       '400':
 *         description: Nome e e-mail são obrigatórios.
 *       '404':
 *         description: Utilizador não encontrado.
 */
app.route('/:id')
  .get(getUserById)
  .put(updateUser);


if (!process.env.JEST_WORKER_ID && process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`[users] listening on http://localhost:${PORT}`);
  });
}