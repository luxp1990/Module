// i18n.js: Bilingual (zh-CN / en-US) internationalization engine
(function () {
  'use strict';

  const MESSAGES = {
    'zh-CN': {
      common: {
        appName: '任务管理器',
        save: '保存',
        saving: '保存中...',
        cancel: '取消',
        delete: '删除',
        confirm: '确认',
        close: '关闭',
        loading: '加载中...',
        error: '错误',
        success: '成功',
        copy: '复制',
        copied: '已复制',
        edit: '编辑',
        add: '添加',
        create: '创建',
        search: '搜索',
        searchPlaceholder: '搜索任务...',
        allProjects: '全部项目',
        reset: '重置',
        resetDefault: '恢复默认',
        apply: '应用',
        clear: '清空',
        selectAll: '全选',
        deselectAll: '取消全选',
        done: '完成',
        yes: '是',
        no: '否',
        none: '无',
        unknown: '未知',
        optional: '可选',
        required: '必填',
        refresh: '刷新',
        export: '导出',
        import: '导入',
        restore: '恢复',
        preview: '预览',
        back: '返回',
        more: '更多',
        settings: '设置',
        help: '帮助',
        enable: '启用',
        disable: '禁用',
        enabled: '已启用',
        disabled: '已禁用',
      },

      priority: {
        p0: 'P0 紧急',
        p1: 'P1 重要',
        p2: 'P2 普通',
        p0Short: 'P0',
        p1Short: 'P1',
        p2Short: 'P2',
        label: '优先级',
      },

      status: {
        todo: '待办',
        progress: '进行中',
        blocked: '阻塞',
        review: '审核中',
        completed: '已完成',
        label: '状态',
      },

      nav: {
        hierarchy: '层级视图',
        deadline: '截止日期',
        gantt: '甘特图',
        completed: '已完成',
        reports: '周报',
        notes: '备忘录',
        viewsTitle: '视图',
        projectsTitle: '项目筛选',
        statsTitle: '统计概览',
        statsTotal: '总任务',
        statsActive: '进行中',
        statsCompleted: '已完成',
        statsOverdue: '已逾期',
        statsDueToday: '今日到期',
        statsCompletionRate: '完成率',
      },

      toolbar: {
        undo: '撤销',
        undoWithLabel: '撤销：{action}',
        autoPlan: '自动规划',
        autoPlanOn: '自动规划：开',
        autoPlanOff: '自动规划：关',
        themeToggle: '切换主题',
        themeDark: '深色模式',
        themeLight: '浅色模式',
        widget: '桌面小组件',
        backup: '数据备份',
        cleanup: '清理过期任务',
        addTask: '+ 新建任务',
        settings: '设置',
        language: '语言',
        exportData: '导出数据',
        importData: '导入数据',
      },

      hierarchy: {
        title: '层级视图',
        empty: '暂无任务，点击“+ 新建任务”开始吧',
        emptyFiltered: '当前筛选条件下没有任务',
        addSubtask: '添加子任务',
        expandAll: '全部展开',
        collapseAll: '全部收起',
        dragHint: '拖拽调整顺序或层级',
        maxLevelReached: '已达到最大子任务层级',
        subtasksCount: '{count} 个子任务',
        progressCount: '{done}/{total}',
      },

      deadline: {
        title: '截止日期',
        overdue: '已逾期',
        today: '今天',
        tomorrow: '明天',
        thisWeek: '本周内',
        nextWeek: '下周',
        later: '更晚',
        noDeadline: '无截止日期',
        empty: '暂无待办任务',
        daysOverdue: '逾期 {days} 天',
        daysLeft: '剩余 {days} 天',
        dueToday: '今日到期',
      },

      gantt: {
        title: '甘特图',
        zoomDay: '日',
        zoomWeek: '周',
        zoomMonth: '月',
        zoomQuarter: '季',
        today: '今天',
        exportExcel: '导出 Excel',
        exportCsv: '导出 CSV',
        exportImage: '导出图片',
        empty: '暂无可展示的任务时间线',
        noDates: '未设置起止日期',
        taskName: '任务名称',
        startDate: '开始日期',
        endDate: '截止日期',
        duration: '工期（天）',
        exportSuccess: '甘特图导出成功',
        exportFailed: '甘特图导出失败：{error}',
      },

      completed: {
        title: '已完成',
        empty: '暂无已完成任务',
        completedAt: '完成于 {time}',
        uncomplete: '恢复为待办',
        deleteForever: '彻底删除',
        cleanupConfirm: '确定要清理超过 {days} 天的已完成任务吗？',
        cleanupSuccess: '已清理 {count} 条过期任务',
        retentionHint: '保留最近 {days} 天的已完成任务',
      },

      reports: {
        title: '周报',
        generate: '生成周报',
        generating: '生成中...',
        aiSummary: 'AI 总结',
        aiGenerating: 'AI 正在生成总结...',
        currentWeek: '本周',
        lastWeek: '上周',
        weekLabel: '{weekId} 周报',
        copyMarkdown: '复制 Markdown',
        deleteReport: '删除周报',
        deleteConfirm: '确定要删除 {weekId} 的周报吗？',
        empty: '暂无周报，点击“生成周报”创建',
        aiSuccess: 'AI 周报总结已生成',
        aiFailed: 'AI 周报生成失败：{error}',
        aiNotConfigured: '请先在设置中配置 AI 服务',
        completedSection: '本周完成',
        inProgressSection: '进行中',
        planSection: '下周计划',
      },

      notes: {
        title: '备忘录',
        newNote: '新建备忘录',
        placeholder: '记录想法、会议纪要或待办碎片...',
        titlePlaceholder: '备忘录标题（可选）',
        empty: '暂无备忘录，点击“新建备忘录”开始记录',
        deleteConfirm: '确定要删除这条备忘录吗？',
        colorLabel: '便签颜色',
        aiExtractTasks: 'AI 提取任务',
        aiExtracting: 'AI 正在提取任务...',
        aiExtractSuccess: '已提取 {count} 个任务',
        aiExtractEmpty: '未从备忘录中识别到可执行任务',
        aiExtractFailed: 'AI 提取任务失败：{error}',
        createExtractedTasks: '批量创建任务',
        updatedAt: '更新于 {time}',
      },

      breakdown: {
        title: 'AI 任务拆解',
        targetTask: '目标任务',
        instructionLabel: '补充拆解要求（可选）',
        instructionPlaceholder: '例如：按前后端联调步骤拆解，每步不超过半天...',
        generate: '开始拆解',
        generating: '正在拆解任务...',
        previewTitle: '建议的子任务',
        emptyResult: '未生成有效的子任务建议',
        addSelected: '添加选中子任务',
        addCount: '添加 {count} 个子任务',
        success: '已添加 {count} 个子任务',
        failed: 'AI 任务拆解失败：{error}',
        selectAtLeastOne: '请至少选择一个子任务',
      },

      modal: {
        createTask: '新建任务',
        editTask: '编辑任务',
        taskTitle: '任务标题',
        taskTitlePlaceholder: '输入任务名称...',
        taskDesc: '任务描述',
        taskDescPlaceholder: '输入详细说明、备注或验收标准...',
        parentTask: '父任务',
        noParent: '无（作为主任务）',
        project: '所属项目',
        projectPlaceholder: '输入或选择项目名称',
        startDate: '开始日期',
        deadline: '截止日期',
        estimatedHours: '预估工时（小时）',
        tags: '标签',
        tagsPlaceholder: '用逗号分隔多个标签',
        backupTitle: '数据备份与恢复',
        backupList: '历史备份',
        backupEmpty: '暂无本地备份记录',
        backupRestoreConfirm: '恢复备份将覆盖当前数据，是否继续？',
        backupRestoreSuccess: '备份恢复成功',
        backupExportSuccess: '数据导出成功',
        backupImportConfirm: '确定要导入该数据文件吗？',
        backupImportSuccess: '数据导入成功',
        importModeMerge: '合并导入',
        importModeOverwrite: '覆盖导入',
        confirmTitle: '确认操作',
        deleteTaskConfirm: '确定要删除任务“{title}”吗？其子任务也将一并删除。',
      },

      contextMenu: {
        edit: '编辑任务',
        addSubtask: '添加子任务',
        complete: '标记完成',
        uncomplete: '恢复待办',
        aiBreakdown: 'AI 拆解子任务',
        setPriority: '设置优先级',
        setStatus: '设置状态',
        setDeadline: '设置截止日期',
        duplicate: '复制任务',
        delete: '删除任务',
      },

      datePicker: {
        today: '今天',
        tomorrow: '明天',
        nextWeek: '下周',
        clear: '清除日期',
        weekdaysShort: ['一', '二', '三', '四', '五', '六', '日'],
        yearMonth: '{year}年{month}月',
      },

      batch: {
        selectedCount: '已选择 {count} 项',
        complete: '批量完成',
        uncomplete: '批量恢复',
        setPriority: '批量设优先级',
        delete: '批量删除',
        deleteConfirm: '确定要删除选中的 {count} 个任务吗？',
        cancel: '取消选择',
      },

      toast: {
        saveSuccess: '保存成功',
        saveFailed: '保存失败：{error}',
        deleteSuccess: '删除成功',
        deleteFailed: '删除失败：{error}',
        taskCreated: '任务已创建',
        taskUpdated: '任务已更新',
        taskCompleted: '任务已完成',
        taskUncompleted: '任务已恢复为待办',
        undoSuccess: '已撤销：{action}',
        undoEmpty: '没有可撤销的操作',
        undoFailed: '撤销失败：{error}',
        copySuccess: '已复制到剪贴板',
        copyFailed: '复制失败',
        loadFailed: '加载失败：{error}',
        networkError: '网络请求失败，请检查网络连接',
        validationTitleRequired: '请输入任务标题',
        validationDateRange: '开始日期不能晚于截止日期',
      },

      undoAction: {
        TASK_CREATED: '新建任务',
        TASK_COMPLETED: '完成任务',
        TASK_UNCOMPLETED: '恢复任务',
        TASK_UPDATED: '更新任务',
        TASK_DELETED: '删除任务',
        TASKS_BATCH_CREATED: '批量创建任务',
        TASKS_BATCH_DELETED: '批量删除任务',
        TASK_REORDERED: '调整任务顺序',
        NOTE_CREATED: '新建备忘录',
        NOTE_UPDATED: '更新备忘录',
        NOTE_DELETED: '删除备忘录',
        NOTES_REORDERED: '调整备忘录顺序',
        DATA_UNDO: '撤销操作',
        DATA_IMPORTED: '导入数据',
        CONFIG_UPDATED: '更新配置',
      },

      settings: {
        docTitle: '设置 - 任务管理器',
        title: '应用设置',
        short: '设置',
        generalSection: '通用设置',
        languageLabel: '界面语言',
        languageAuto: '跟随系统',
        languageZhCN: '简体中文',
        languageEnUS: 'English',
        hotkeyLabel: '全局快捷键',
        hotkeyPlaceholder: '例如：Alt+Space',
        hotkeyHint: '用于快速唤起或隐藏主窗口',
        hotkeySaved: '快捷键已更新',
        hotkeyFailed: '快捷键设置失败：{error}',
        retentionLabel: '已完成任务保留天数',
        retentionUnit: '天',
        retentionHint: '超过该天数的已完成任务可在清理时移除',
        reminderSection: '每日提醒',
        reminderEnable: '开启每日任务提醒',
        reminderTimeLabel: '提醒时间',
        reminderIncludeOverdue: '包含已逾期任务',
        aiSection: 'AI 助手配置',
        aiProvider: '服务商',
        aiProviderOpenAI: 'OpenAI',
        aiProviderDeepSeek: 'DeepSeek',
        aiProviderGemini: 'Gemini',
        aiApiKey: 'API Key',
        aiApiKeyPlaceholder: '输入 API Key（安全存储在本地）',
        aiBaseUrl: 'Base URL',
        aiBaseUrlPlaceholder: '可选，自定义接口地址',
        aiModel: '模型名称',
        aiModelPlaceholder: '例如：gpt-4o-mini / deepseek-chat / gemini-2.5-flash',
        aiTestConnection: '测试连接',
        aiTesting: '正在测试连接...',
        aiTestSuccess: '连接成功',
        aiTestFailed: '连接失败：{error}',
        aiAdvancedPrompts: '高级提示词设置',
        aiPromptWeeklyReport: '周报总结提示词',
        aiPromptBreakdown: '任务拆解提示词',
        aiPromptNotesToTasks: '备忘录转任务提示词',
        aiResetPrompts: '恢复默认提示词',
        aiPromptsResetDone: '已恢复默认提示词',
        saveSettings: '保存设置',
        saved: '设置已保存',
        saveFailed: '保存设置失败：{error}',
      },

      widget: {
        docTitle: '桌面待办 - 任务管理器',
        title: '今日待办',
        pin: '置顶窗口',
        unpin: '取消置顶',
        openMain: '打开主窗口',
        quickAddPlaceholder: '快速添加待办，按回车保存...',
        empty: '今日暂无待办任务',
        overdueSection: '已逾期',
        todaySection: '今天',
        upcomingSection: '即将到期',
        taskCount: '{count} 项',
      },

      reminder: {
        docTitle: '任务提醒 - 任务管理器',
        title: '每日任务提醒',
        subtitle: '以下任务需要您的关注',
        overdueGroup: '已逾期 ({count})',
        todayGroup: '今日到期 ({count})',
        empty: '太棒了，今天没有逾期或到期的待办任务！',
        focusTask: '定位任务',
        openMain: '打开主窗口',
        dismiss: '知道了',
        snooze: '稍后提醒',
      },
    },

    'en-US': {
      common: {
        appName: 'Task Manager',
        save: 'Save',
        saving: 'Saving...',
        cancel: 'Cancel',
        delete: 'Delete',
        confirm: 'Confirm',
        close: 'Close',
        loading: 'Loading...',
        error: 'Error',
        success: 'Success',
        copy: 'Copy',
        copied: 'Copied',
        edit: 'Edit',
        add: 'Add',
        create: 'Create',
        search: 'Search',
        searchPlaceholder: 'Search tasks...',
        allProjects: 'All Projects',
        reset: 'Reset',
        resetDefault: 'Reset Default',
        apply: 'Apply',
        clear: 'Clear',
        selectAll: 'Select All',
        deselectAll: 'Deselect All',
        done: 'Done',
        yes: 'Yes',
        no: 'No',
        none: 'None',
        unknown: 'Unknown',
        optional: 'Optional',
        required: 'Required',
        refresh: 'Refresh',
        export: 'Export',
        import: 'Import',
        restore: 'Restore',
        preview: 'Preview',
        back: 'Back',
        more: 'More',
        settings: 'Settings',
        help: 'Help',
        enable: 'Enable',
        disable: 'Disable',
        enabled: 'Enabled',
        disabled: 'Disabled',
      },

      priority: {
        p0: 'P0 Urgent',
        p1: 'P1 High',
        p2: 'P2 Normal',
        p0Short: 'P0',
        p1Short: 'P1',
        p2Short: 'P2',
        label: 'Priority',
      },

      status: {
        todo: 'To Do',
        progress: 'In Progress',
        blocked: 'Blocked',
        review: 'In Review',
        completed: 'Completed',
        label: 'Status',
      },

      nav: {
        hierarchy: 'Hierarchy',
        deadline: 'Deadlines',
        gantt: 'Gantt',
        completed: 'Completed',
        reports: 'Reports',
        notes: 'Notes',
        viewsTitle: 'Views',
        projectsTitle: 'Projects',
        statsTitle: 'Overview',
        statsTotal: 'Total',
        statsActive: 'Active',
        statsCompleted: 'Completed',
        statsOverdue: 'Overdue',
        statsDueToday: 'Due Today',
        statsCompletionRate: 'Completion',
      },

      toolbar: {
        undo: 'Undo',
        undoWithLabel: 'Undo: {action}',
        autoPlan: 'Auto-Plan',
        autoPlanOn: 'Auto-Plan: On',
        autoPlanOff: 'Auto-Plan: Off',
        themeToggle: 'Toggle Theme',
        themeDark: 'Dark Mode',
        themeLight: 'Light Mode',
        widget: 'Desktop Widget',
        backup: 'Data Backup',
        cleanup: 'Cleanup',
        addTask: '+ Add',
        settings: 'Settings',
        language: 'Language',
        exportData: 'Export Data',
        importData: 'Import Data',
      },

      hierarchy: {
        title: 'Hierarchy',
        empty: 'No tasks yet. Click "+ Add" to get started.',
        emptyFiltered: 'No tasks match the current filter.',
        addSubtask: 'Add Subtask',
        expandAll: 'Expand All',
        collapseAll: 'Collapse All',
        dragHint: 'Drag to reorder or nest',
        maxLevelReached: 'Maximum subtask nesting depth reached',
        subtasksCount: '{count} subtasks',
        progressCount: '{done}/{total}',
      },

      deadline: {
        title: 'Deadlines',
        overdue: 'Overdue',
        today: 'Today',
        tomorrow: 'Tomorrow',
        thisWeek: 'This Week',
        nextWeek: 'Next Week',
        later: 'Later',
        noDeadline: 'No Deadline',
        empty: 'No active tasks',
        daysOverdue: '{days}d overdue',
        daysLeft: '{days}d left',
        dueToday: 'Due today',
      },

      gantt: {
        title: 'Gantt',
        zoomDay: 'Day',
        zoomWeek: 'Week',
        zoomMonth: 'Month',
        zoomQuarter: 'Quarter',
        today: 'Today',
        exportExcel: 'Export Excel',
        exportCsv: 'Export CSV',
        exportImage: 'Export Image',
        empty: 'No tasks available for timeline view',
        noDates: 'No start/end dates',
        taskName: 'Task',
        startDate: 'Start Date',
        endDate: 'End Date',
        duration: 'Duration (d)',
        exportSuccess: 'Gantt chart exported successfully',
        exportFailed: 'Failed to export Gantt chart: {error}',
      },

      completed: {
        title: 'Completed',
        empty: 'No completed tasks',
        completedAt: 'Completed {time}',
        uncomplete: 'Mark as To Do',
        deleteForever: 'Delete Permanently',
        cleanupConfirm: 'Clean up completed tasks older than {days} days?',
        cleanupSuccess: 'Cleaned up {count} expired tasks',
        retentionHint: 'Keep completed tasks for {days} days',
      },

      reports: {
        title: 'Reports',
        generate: 'Generate Report',
        generating: 'Generating...',
        aiSummary: 'AI Summary',
        aiGenerating: 'Generating AI summary...',
        currentWeek: 'This Week',
        lastWeek: 'Last Week',
        weekLabel: 'Week {weekId} Report',
        copyMarkdown: 'Copy Markdown',
        deleteReport: 'Delete Report',
        deleteConfirm: 'Delete weekly report for {weekId}?',
        empty: 'No reports yet. Click "Generate Report" to create one.',
        aiSuccess: 'AI weekly summary generated',
        aiFailed: 'AI report generation failed: {error}',
        aiNotConfigured: 'Please configure AI settings first',
        completedSection: 'Completed This Week',
        inProgressSection: 'In Progress',
        planSection: 'Next Week Plan',
      },

      notes: {
        title: 'Notes',
        newNote: 'New Note',
        placeholder: 'Write down ideas, meeting notes, or quick thoughts...',
        titlePlaceholder: 'Note title (optional)',
        empty: 'No notes yet. Click "New Note" to start writing.',
        deleteConfirm: 'Delete this note?',
        colorLabel: 'Note Color',
        aiExtractTasks: 'AI Extract Tasks',
        aiExtracting: 'Extracting tasks with AI...',
        aiExtractSuccess: 'Extracted {count} tasks',
        aiExtractEmpty: 'No actionable tasks found in this note',
        aiExtractFailed: 'AI task extraction failed: {error}',
        createExtractedTasks: 'Create Tasks',
        updatedAt: 'Updated {time}',
      },

      breakdown: {
        title: 'AI Task Breakdown',
        targetTask: 'Target Task',
        instructionLabel: 'Additional Instructions (Optional)',
        instructionPlaceholder: 'e.g., Split into frontend/backend steps under half a day each...',
        generate: 'Break Down',
        generating: 'Breaking down task...',
        previewTitle: 'Suggested Subtasks',
        emptyResult: 'No valid subtasks were generated',
        addSelected: 'Add Selected Subtasks',
        addCount: 'Add {count} Subtasks',
        success: 'Added {count} subtasks',
        failed: 'AI task breakdown failed: {error}',
        selectAtLeastOne: 'Please select at least one subtask',
      },

      modal: {
        createTask: 'New Task',
        editTask: 'Edit Task',
        taskTitle: 'Task Title',
        taskTitlePlaceholder: 'Enter task title...',
        taskDesc: 'Description',
        taskDescPlaceholder: 'Enter details, notes, or acceptance criteria...',
        parentTask: 'Parent Task',
        noParent: 'None (Top-level Task)',
        project: 'Project',
        projectPlaceholder: 'Enter or select project name',
        startDate: 'Start Date',
        deadline: 'Deadline',
        estimatedHours: 'Estimated Hours',
        tags: 'Tags',
        tagsPlaceholder: 'Comma-separated tags',
        backupTitle: 'Data Backup & Restore',
        backupList: 'Backup History',
        backupEmpty: 'No local backups found',
        backupRestoreConfirm: 'Restoring a backup will overwrite current data. Continue?',
        backupRestoreSuccess: 'Backup restored successfully',
        backupExportSuccess: 'Data exported successfully',
        backupImportConfirm: 'Import this data file?',
        backupImportSuccess: 'Data imported successfully',
        importModeMerge: 'Merge',
        importModeOverwrite: 'Overwrite',
        confirmTitle: 'Confirm Action',
        deleteTaskConfirm: 'Delete task "{title}"? Its subtasks will also be deleted.',
      },

      contextMenu: {
        edit: 'Edit Task',
        addSubtask: 'Add Subtask',
        complete: 'Mark Complete',
        uncomplete: 'Mark To Do',
        aiBreakdown: 'AI Break Down',
        setPriority: 'Set Priority',
        setStatus: 'Set Status',
        setDeadline: 'Set Deadline',
        duplicate: 'Duplicate Task',
        delete: 'Delete Task',
      },

      datePicker: {
        today: 'Today',
        tomorrow: 'Tomorrow',
        nextWeek: 'Next Week',
        clear: 'Clear Date',
        weekdaysShort: ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'],
        yearMonth: '{year}-{month}',
      },

      batch: {
        selectedCount: '{count} selected',
        complete: 'Complete',
        uncomplete: 'Restore',
        setPriority: 'Set Priority',
        delete: 'Delete',
        deleteConfirm: 'Delete {count} selected tasks?',
        cancel: 'Clear Selection',
      },

      toast: {
        saveSuccess: 'Saved successfully',
        saveFailed: 'Failed to save: {error}',
        deleteSuccess: 'Deleted successfully',
        deleteFailed: 'Failed to delete: {error}',
        taskCreated: 'Task created',
        taskUpdated: 'Task updated',
        taskCompleted: 'Task completed',
        taskUncompleted: 'Task restored to To Do',
        undoSuccess: 'Undone: {action}',
        undoEmpty: 'Nothing to undo',
        undoFailed: 'Undo failed: {error}',
        copySuccess: 'Copied to clipboard',
        copyFailed: 'Copy failed',
        loadFailed: 'Failed to load: {error}',
        networkError: 'Network request failed. Please check your connection.',
        validationTitleRequired: 'Please enter a task title',
        validationDateRange: 'Start date cannot be later than deadline',
      },

      undoAction: {
        TASK_CREATED: 'Create Task',
        TASK_COMPLETED: 'Complete Task',
        TASK_UNCOMPLETED: 'Restore Task',
        TASK_UPDATED: 'Update Task',
        TASK_DELETED: 'Delete Task',
        TASKS_BATCH_CREATED: 'Batch Create Tasks',
        TASKS_BATCH_DELETED: 'Batch Delete Tasks',
        TASK_REORDERED: 'Reorder Tasks',
        NOTE_CREATED: 'Create Note',
        NOTE_UPDATED: 'Update Note',
        NOTE_DELETED: 'Delete Note',
        NOTES_REORDERED: 'Reorder Notes',
        DATA_UNDO: 'Undo Action',
        DATA_IMPORTED: 'Import Data',
        CONFIG_UPDATED: 'Update Settings',
      },

      settings: {
        docTitle: 'Settings - Task Manager',
        title: 'Settings',
        short: 'Settings',
        generalSection: 'General',
        languageLabel: 'Language',
        languageAuto: 'Follow System',
        languageZhCN: '简体中文',
        languageEnUS: 'English',
        hotkeyLabel: 'Global Hotkey',
        hotkeyPlaceholder: 'e.g. Alt+Space',
        hotkeyHint: 'Quickly toggle the main window',
        hotkeySaved: 'Hotkey updated',
        hotkeyFailed: 'Failed to set hotkey: {error}',
        retentionLabel: 'Completed Task Retention',
        retentionUnit: 'days',
        retentionHint: 'Completed tasks older than this can be cleaned up',
        reminderSection: 'Daily Reminder',
        reminderEnable: 'Enable Daily Task Reminder',
        reminderTimeLabel: 'Reminder Time',
        reminderIncludeOverdue: 'Include overdue tasks',
        aiSection: 'AI Configuration',
        aiProvider: 'Provider',
        aiProviderOpenAI: 'OpenAI',
        aiProviderDeepSeek: 'DeepSeek',
        aiProviderGemini: 'Gemini',
        aiApiKey: 'API Key',
        aiApiKeyPlaceholder: 'Enter API Key (stored locally)',
        aiBaseUrl: 'Base URL',
        aiBaseUrlPlaceholder: 'Optional custom endpoint URL',
        aiModel: 'Model',
        aiModelPlaceholder: 'e.g. gpt-4o-mini / deepseek-chat / gemini-2.5-flash',
        aiTestConnection: 'Test Connection',
        aiTesting: 'Testing connection...',
        aiTestSuccess: 'Connection successful',
        aiTestFailed: 'Connection failed: {error}',
        aiAdvancedPrompts: 'Advanced Prompts',
        aiPromptWeeklyReport: 'Weekly Report Prompt',
        aiPromptBreakdown: 'Task Breakdown Prompt',
        aiPromptNotesToTasks: 'Notes to Tasks Prompt',
        aiResetPrompts: 'Reset Default',
        aiPromptsResetDone: 'Prompts reset to default',
        saveSettings: 'Save Settings',
        saved: 'Settings saved',
        saveFailed: 'Failed to save settings: {error}',
      },

      widget: {
        docTitle: 'Desktop Widget - Task Manager',
        title: 'Today',
        pin: 'Pin on Top',
        unpin: 'Unpin',
        openMain: 'Open Main Window',
        quickAddPlaceholder: 'Quick add task, press Enter...',
        empty: 'No tasks due today',
        overdueSection: 'Overdue',
        todaySection: 'Today',
        upcomingSection: 'Upcoming',
        taskCount: '{count} items',
      },

      reminder: {
        docTitle: 'Reminder - Task Manager',
        title: 'Daily Task Reminder',
        subtitle: 'These tasks need your attention',
        overdueGroup: 'Overdue ({count})',
        todayGroup: 'Due Today ({count})',
        empty: 'All caught up! No overdue or due-today tasks.',
        focusTask: 'View Task',
        openMain: 'Open Main Window',
        dismiss: 'Dismiss',
        snooze: 'Snooze',
      },
    },
  };

  let currentSetting = 'auto';
  let currentLocale = resolveLocale('auto');

  /**
   * Resolve a language setting ('auto', 'zh-CN', 'en-US') to a concrete locale.
   * @param {string} [setting]
   * @returns {'zh-CN' | 'en-US'}
   */
  function resolveLocale(setting) {
    if (setting === 'zh-CN' || setting === 'en-US') {
      return setting;
    }
    const navLang = (typeof navigator !== 'undefined' && navigator.language)
      ? navigator.language
      : 'zh-CN';
    if (!String(navLang).toLowerCase().startsWith('zh')) {
      return 'en-US';
    }
    return 'zh-CN';
  }

  function lookupKey(dict, key) {
    if (!dict || typeof key !== 'string') return undefined;
    if (Object.prototype.hasOwnProperty.call(dict, key)) {
      return dict[key];
    }
    const parts = key.split('.');
    let node = dict;
    for (let i = 0; i < parts.length; i++) {
      if (node && typeof node === 'object' && Object.prototype.hasOwnProperty.call(node, parts[i])) {
        node = node[parts[i]];
      } else {
        return undefined;
      }
    }
    return typeof node === 'string' || Array.isArray(node) ? node : undefined;
  }

  function formatString(template, params) {
    if (typeof template !== 'string' || !params) return template;
    return template.replace(/\{(\w+)\}/g, function (match, name) {
      return Object.prototype.hasOwnProperty.call(params, name) && params[name] !== undefined && params[name] !== null
        ? String(params[name])
        : match;
    });
  }

  /**
   * Translate a key for the active locale with optional `{param}` interpolation.
   * @param {string} key
   * @param {Record<string, unknown>} [params]
   * @returns {string}
   */
  function t(key, params) {
    let val = lookupKey(MESSAGES[currentLocale], key);
    if (val === undefined) {
      val = lookupKey(MESSAGES['zh-CN'], key);
    }
    if (val === undefined) {
      val = lookupKey(MESSAGES['en-US'], key);
    }
    if (val === undefined) {
      return key;
    }
    if (typeof val === 'string') {
      return formatString(val, params);
    }
    return val;
  }

  /**
   * Apply translations to DOM elements under `root` (defaults to `document`).
   * Handles [data-i18n], [data-i18n-placeholder], [data-i18n-title], [data-i18n-aria],
   * and <title> via html[data-i18n-doc-title] or title[data-i18n].
   * @param {ParentNode} [root]
   */
  function applyDom(root) {
    if (typeof document === 'undefined') return;
    const scope = root || document;

    const textNodes = scope.querySelectorAll('[data-i18n]');
    for (let i = 0; i < textNodes.length; i++) {
      const el = textNodes[i];
      const key = el.getAttribute('data-i18n');
      if (key) {
        el.textContent = t(key);
      }
    }

    const placeholderNodes = scope.querySelectorAll('[data-i18n-placeholder]');
    for (let i = 0; i < placeholderNodes.length; i++) {
      const el = placeholderNodes[i];
      const key = el.getAttribute('data-i18n-placeholder');
      if (key) {
        el.setAttribute('placeholder', t(key));
      }
    }

    const titleNodes = scope.querySelectorAll('[data-i18n-title]');
    for (let i = 0; i < titleNodes.length; i++) {
      const el = titleNodes[i];
      const key = el.getAttribute('data-i18n-title');
      if (key) {
        el.setAttribute('title', t(key));
      }
    }

    const ariaNodes = scope.querySelectorAll('[data-i18n-aria]');
    for (let i = 0; i < ariaNodes.length; i++) {
      const el = ariaNodes[i];
      const key = el.getAttribute('data-i18n-aria');
      if (key) {
        el.setAttribute('aria-label', t(key));
      }
    }

    if (scope === document && document.documentElement) {
      const docTitleKey = document.documentElement.getAttribute('data-i18n-doc-title');
      if (docTitleKey) {
        document.title = t(docTitleKey);
      } else {
        const titleEl = document.querySelector('title[data-i18n]');
        if (titleEl) {
          const titleKey = titleEl.getAttribute('data-i18n');
          if (titleKey) {
            document.title = t(titleKey);
          }
        }
      }
    }
  }

  /**
   * Set the active locale from a setting ('auto', 'zh-CN', 'en-US'),
   * update <html lang>, translate the DOM, and notify the Rust tray if available.
   * @param {string} [setting]
   * @returns {'zh-CN' | 'en-US'}
   */
  function setLocale(setting) {
    currentSetting = setting || 'auto';
    currentLocale = resolveLocale(currentSetting);

    if (typeof document !== 'undefined' && document.documentElement) {
      document.documentElement.lang = currentLocale;
      applyDom(document);
    }

    if (
      typeof window !== 'undefined' &&
      window.api &&
      window.api.app &&
      typeof window.api.app.updateTrayLanguage === 'function'
    ) {
      try {
        const res = window.api.app.updateTrayLanguage(currentLocale);
        if (res && typeof res.catch === 'function') {
          res.catch(function () {});
        }
      } catch (_) {
        // Ignore tray update errors outside Tauri runtime
      }
    }

    return currentLocale;
  }

  function getLocale() {
    return currentLocale;
  }

  function getSetting() {
    return currentSetting;
  }

  function hasKey(key, locale) {
    const target = locale ? resolveLocale(locale) : currentLocale;
    return lookupKey(MESSAGES[target], key) !== undefined;
  }

  function getMessages(locale) {
    const target = locale ? resolveLocale(locale) : currentLocale;
    return MESSAGES[target];
  }

  const I18n = {
    t: t,
    resolveLocale: resolveLocale,
    setLocale: setLocale,
    getLocale: getLocale,
    getSetting: getSetting,
    applyDom: applyDom,
    hasKey: hasKey,
    getMessages: getMessages,
  };

  if (typeof window !== 'undefined') {
    window.ModuleApp = window.ModuleApp || {};
    window.ModuleApp.I18n = I18n;
    window.t = t;
  }
})();
