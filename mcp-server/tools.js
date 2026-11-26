// Module MCP Server — 工具注册表与 Schema 定义
'use strict';

const tools = [
  {
    name: 'get_tasks',
    description: '查询任务列表，支持按完成状态、优先级、父任务、关键词过滤以及数量限制。',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['active', 'completed', 'all'],
          description: '任务状态过滤：active(未完成，默认), completed(已完成), all(全部)'
        },
        priority: {
          type: 'string',
          enum: ['p0', 'p1', 'p2'],
          description: '优先级过滤：p0(最高), p1(中等), p2(普通)'
        },
        parentId: {
          type: 'string',
          description: '指定父任务ID过滤子任务，传入 "root" 表示仅查询顶层主任务'
        },
        keyword: {
          type: 'string',
          description: '按任务标题或备注内容进行模糊搜索'
        },
        scopeId: {
          type: 'string',
          description: '项目作用域ID：仅返回属于该主任务节点及其所有子孙后代的任务'
        },
        limit: {
          type: 'integer',
          description: '返回数量上限，默认 50 条'
        }
      }
    },
    handler: async (bridge, args) => bridge.getTasks(args)
  },
  {
    name: 'get_task_tree',
    description: '获取树形层级任务结构，递归返回主任务及其子任务、孙子任务树。',
    inputSchema: {
      type: 'object',
      properties: {
        activeOnly: {
          type: 'boolean',
          description: '是否仅获取未完成的任务树，默认为 true'
        },
        scopeId: {
          type: 'string',
          description: '可选：指定根节点主任务ID，只返回该分支任务树'
        }
      }
    },
    handler: async (bridge, args) => bridge.getTaskTree(args)
  },
  {
    name: 'create_task',
    description: '创建单个主任务或子任务。系统自动遵守最大5级层级约束，并在子任务日期更新时自动触发 autoPlan 向上计算更新父任务起止工期。',
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: '任务标题与内容（必填）'
        },
        parentId: {
          type: 'string',
          description: '父任务ID；若不传或留空则创建顶层主任务'
        },
        priority: {
          type: 'string',
          enum: ['p0', 'p1', 'p2'],
          description: '任务优先级：p0(高), p1(中,默认), p2(低)'
        },
        startDate: {
          type: 'string',
          description: '开始日期，格式 YYYY-MM-DD，如 2026-11-03'
        },
        deadline: {
          type: 'string',
          description: '截止日期，格式 YYYY-MM-DD，如 2026-11-05'
        },
        notes: {
          type: 'string',
          description: '详细备注说明或补充信息'
        }
      },
      required: ['content']
    },
    handler: async (bridge, args) => bridge.createTask(args)
  },
  {
    name: 'batch_create_tasks',
    description: '批量创建任务，适合将大目标一次性拆解为多个子步骤。',
    inputSchema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description: '待创建的任务列表',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: '任务标题（必填）' },
              parentId: { type: 'string', description: '父任务ID' },
              priority: { type: 'string', enum: ['p0', 'p1', 'p2'] },
              startDate: { type: 'string', description: 'YYYY-MM-DD' },
              deadline: { type: 'string', description: 'YYYY-MM-DD' },
              notes: { type: 'string' }
            },
            required: ['content']
          }
        }
      },
      required: ['tasks']
    },
    handler: async (bridge, args) => bridge.batchCreateTasks(args.tasks)
  },
  {
    name: 'update_task',
    description: '更新指定任务的内容、工期、优先级或备注。',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: '任务唯一ID（必填）'
        },
        content: {
          type: 'string',
          description: '更新后的任务标题'
        },
        startDate: {
          type: 'string',
          description: '开始日期 YYYY-MM-DD（传 null 可清空）'
        },
        deadline: {
          type: 'string',
          description: '截止日期 YYYY-MM-DD（传 null 可清空）'
        },
        priority: {
          type: 'string',
          enum: ['p0', 'p1', 'p2'],
          description: '优先级'
        },
        notes: {
          type: 'string',
          description: '详细备注'
        }
      },
      required: ['id']
    },
    handler: async (bridge, args) => {
      const { id, ...updates } = args;
      return bridge.updateTask(id, updates);
    }
  },
  {
    name: 'complete_task',
    description: '标记任务完成状态。支持标记已完成或将已完成任务重新激活。',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: '任务ID（必填）'
        },
        completed: {
          type: 'boolean',
          description: 'true 表示标记为已完成，false 表示取消完成重新激活，默认为 true'
        }
      },
      required: ['id']
    },
    handler: async (bridge, args) => bridge.completeTask(args.id, args.completed !== false)
  },
  {
    name: 'delete_task',
    description: '删除指定任务。若该任务下有子任务，将级联递归删除其所有子孙任务。',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: '要删除的任务ID（必填）'
        }
      },
      required: ['id']
    },
    handler: async (bridge, args) => bridge.deleteTask(args.id)
  },
  {
    name: 'get_deadline_buckets',
    description: '获取任务截止时间分桶统计看板（包含逾期 overdue、今天截止 today、明天截止 tomorrow、本周截止等分类）。',
    inputSchema: {
      type: 'object',
      properties: {}
    },
    handler: async (bridge) => bridge.getDeadlineBuckets()
  },
  {
    name: 'get_gantt_data',
    description: '获取甘特图时间线排期视图数据，包含起止时间跨度、层级与进度。',
    inputSchema: {
      type: 'object',
      properties: {}
    },
    handler: async (bridge) => bridge.getGanttData()
  },
  {
    name: 'get_weekly_report',
    description: '获取或生成工作周报。返回该周完成的任务流转清单、每日完成统计及复盘备注。',
    inputSchema: {
      type: 'object',
      properties: {
        weekId: {
          type: 'string',
          description: '周ID，格式如 2026-W34；不传则默认为当前周'
        },
        generateIfMissing: {
          type: 'boolean',
          description: '若该周报尚不存在是否立即自动生成，默认为 true'
        }
      }
    },
    handler: async (bridge, args) => bridge.getWeeklyReport(args ? args.weekId : null, args ? args.generateIfMissing : true)
  },
  {
    name: 'manage_notes',
    description: '管理随手记便签（支持查询、新建、更新、置顶与删除）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'create', 'update', 'delete'],
          description: '操作类型：list(查看), create(新建), update(更新), delete(删除)'
        },
        id: {
          type: 'string',
          description: '便签ID（update 和 delete 时必填）'
        },
        content: {
          type: 'string',
          description: '便签内容（create 和 update 时必填）'
        },
        pinned: {
          type: 'boolean',
          description: '是否置顶便签'
        }
      },
      required: ['action']
    },
    handler: async (bridge, args) => bridge.manageNotes(args)
  }
];

module.exports = tools;
