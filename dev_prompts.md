我们现在要实现基于 ACP 协议的一个飞书的编程智能体接入程序。
请通过 typescript 来构建当前的项目。通过 dotenv 进行变量管理。
我们通过 ACP 协议构建起和 kimi cli 的标准化通信函数，使用 @agentclientprotocol/sdk 这个库作为 ACP 客户端框架。
kimi cli ACP 协议的支持文档为： https://moonshotai.github.io/kimi-cli/en/reference/kimi-acp.html
使用 @larksuiteoapi/node-sdk 作为和飞书通信的框架，除此之外，ACP 客户端从服务端得到的信息，先需要通过转换层将编程智能体输出的 markdown 转换成可以在飞书里更加漂亮渲染的 lark md，并且以post类型的数据输出卡片信息。
lark md 标准自己搜。
你需要保证编程智能体返回的 markdown 能够在飞书正常的渲染，并同时支持多级标题、有序无序列表、表格、行间代码块和行内代码块并支持对应的语法格量。

默认的 .env 模板为

# 飞书应用配置（必填）
FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# ACP Agent 配置
ACP_DEFAULT_CWD=/Users/yourname/projects
KIMI_PATH=kimi

# 开启后当前项目，需要将编程智能体通过ECP协议返回的thinking和toolcall内容也一并发送到聊天软件里面。
DEBUG=false

# 思考过程和工具调用显示模式: force(不显示), summary(摘要), detailed(详细)
SHOW_THINKING_TOOL=force
