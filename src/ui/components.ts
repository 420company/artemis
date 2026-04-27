/**
 * Artemis UI 组件库
 * 提供基础的 CLI 和 Web UI 组件
 */

// 由于 blessed 模块类型声明问题，使用 any 类型避免类型检查错误
const blessed = require('blessed') as any;

// CLI 布局组件
export const createLayout = (screen: any) => {
  const layout = blessed.box({
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    border: 'line',
    style: {
      border: {
        fg: 'cyan'
      }
    }
  });

  // 头部
  const header = blessed.box({
    top: 0,
    left: 0,
    width: '100%',
    height: 1,
    content: ' Artemis AI System v0.5.3 ',
    style: {
      fg: 'black',
      bg: 'cyan',
      bold: true
    }
  });

  // 侧边栏
  const sidebar = blessed.box({
    top: 1,
    left: 0,
    width: 30,
    height: '100%-2',
    border: 'line',
    style: {
      border: {
        fg: 'blue'
      }
    }
  });

  // 主内容区域
  const content = blessed.box({
    top: 1,
    left: 30,
    width: '100%-30',
    height: '100%-2',
    border: 'line',
    style: {
      border: {
        fg: 'blue'
      }
    },
    scrollable: true,
    alwaysScroll: true,
    tags: true
  });

  // 底部状态栏
  const statusBar = blessed.box({
    bottom: 0,
    left: 0,
    width: '100%',
    height: 1,
    content: ' Press q to quit | v:0.5.3 | Node:v20.17.0 ',
    style: {
      fg: 'black',
      bg: 'cyan'
    }
  });

  // 添加到布局
  layout.append(header);
  layout.append(sidebar);
  layout.append(content);
  layout.append(statusBar);

  return { layout, header, sidebar, content, statusBar };
};

// 命令面板
export const createCommandPanel = (parent: any) => {
  const panel = blessed.box({
    top: 0,
    left: 0,
    width: '100%',
    height: 5,
    border: 'line',
    style: {
      border: {
        fg: 'yellow'
      }
    },
    tags: true,
    content: '{bold}Available Commands{/bold}\n  help, quit, list, exec, config'
  });

  parent.append(panel);
  return panel;
};

// 工具列表
export const createToolList = (parent: any) => {
  const list = blessed.list({
    top: 5,
    left: 0,
    width: '100%',
    height: '100%-5',
    border: 'line',
    style: {
      border: {
        fg: 'magenta'
      },
      selected: {
        bg: 'blue',
        fg: 'white'
      }
    },
    tags: true,
    keys: true,
    vi: true
  });

  parent.append(list);
  return list;
};

// 执行表单
export const createExecutionForm = (parent: any) => {
  const form = blessed.form({
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    border: 'line',
    style: {
      border: {
        fg: 'green'
      }
    }
  });

  const prompt = blessed.textbox({
    top: 1,
    left: 2,
    width: '100%-4',
    height: 1,
    name: 'prompt',
    inputOnFocus: true,
    border: 'line',
    style: {
      border: {
        fg: 'cyan'
      },
      focus: {
        border: {
          fg: 'red'
        }
      }
    },
    placeholder: 'Enter your prompt...'
  });

  const executeButton = blessed.button({
    bottom: 1,
    left: 'center',
    width: 20,
    height: 3,
    content: '{bold}Execute{/bold}',
    name: 'execute',
    align: 'center',
    border: 'line',
    style: {
      border: {
        fg: 'cyan'
      },
      hover: {
        bg: 'blue'
      },
      focus: {
        bg: 'blue'
      }
    }
  });

  form.append(prompt);
  form.append(executeButton);
  parent.append(form);

  return { form, prompt, executeButton };
};

// 输出日志
export const createOutputLog = (parent: any) => {
  const log = blessed.log({
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    border: 'line',
    style: {
      border: {
        fg: 'orange'
      }
    },
    scrollable: true,
    alwaysScroll: true,
    tags: true
  });

  parent.append(log);
  return log;
};

// 状态指示器
export const createStatusIndicator = (parent: any, x: number, y: number) => {
  const indicator = blessed.box({
    top: y,
    left: x,
    width: 2,
    height: 1,
    style: {
      bg: 'red'
    }
  });

  parent.append(indicator);

  return {
    setStatus(status: 'idle' | 'running' | 'error' | 'success') {
      const colors: any = {
        idle: 'blue',
        running: 'yellow',
        error: 'red',
        success: 'green'
      };
      indicator.style.bg = colors[status];
    }
  };
};

// 进度条
export const createProgressBar = (parent: any, x: number, y: number, width: number) => {
  const bar = blessed.box({
    top: y,
    left: x,
    width: width,
    height: 1,
    border: 'line',
    style: {
      border: {
        fg: 'cyan'
      }
    }
  });

  const progress = blessed.box({
    top: 0,
    left: 0,
    width: 0,
    height: '100%',
    style: {
      bg: 'green'
    }
  });

  const text = blessed.text({
    top: 0,
    left: 'center',
    width: '100%',
    height: 1,
    content: '0%',
    align: 'center'
  });

  bar.append(progress);
  bar.append(text);
  parent.append(bar);

  return {
    setProgress(percent: number) {
      const w = Math.floor((width - 2) * (percent / 100));
      progress.width = w;
      text.content = `${Math.floor(percent)}%`;
    }
  };
};

// 通知组件
export const createNotification = (parent: any, message: string, type: 'info' | 'warning' | 'error' | 'success' = 'info') => {
  const colors: any = {
    info: 'blue',
    warning: 'yellow',
    error: 'red',
    success: 'green'
  };

  const notification = blessed.box({
    top: 'center',
    left: 'center',
    width: Math.min(80, message.length + 4),
    height: 3,
    border: 'line',
    style: {
      border: {
        fg: colors[type]
      }
    },
    tags: true,
    content: `{bold}${message}{/bold}`
  });

  parent.append(notification);

  return notification;
};

// 确认对话框
export const createConfirmDialog = (parent: any, message: string) => {
  const dialog = blessed.box({
    top: 'center',
    left: 'center',
    width: Math.min(80, message.length + 4),
    height: 5,
    border: 'line',
    style: {
      border: {
        fg: 'cyan'
      }
    },
    tags: true
  });

  const text = blessed.text({
    top: 1,
    left: 2,
    width: '100%-4',
    height: 1,
    content: message
  });

  const yesButton = blessed.button({
    bottom: 1,
    left: '33%',
    width: 8,
    height: 1,
    content: 'Yes',
    border: 'line',
    style: {
      border: {
        fg: 'green'
      }
    }
  });

  const noButton = blessed.button({
    bottom: 1,
    left: '66%',
    width: 8,
    height: 1,
    content: 'No',
    border: 'line',
    style: {
      border: {
        fg: 'red'
      }
    }
  });

  dialog.append(text);
  dialog.append(yesButton);
  dialog.append(noButton);
  parent.append(dialog);

  return { dialog, text, yesButton, noButton };
};
