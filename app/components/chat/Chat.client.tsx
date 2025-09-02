/*
 * @ts-nocheck
 * Preventing TS checks with files presented in the video for a better presentation.
 */
import { useStore } from '@nanostores/react';
import type { Message } from 'ai';
import { useChat } from 'ai/react';
import { useAnimate } from 'framer-motion';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { cssTransition, toast, ToastContainer } from 'react-toastify';
import { useMessageParser, usePromptEnhancer, useShortcuts } from '~/lib/hooks';
import { description, useChatHistory } from '~/lib/persistence';
import { chatStore } from '~/lib/stores/chat';
import { workbenchStore } from '~/lib/stores/workbench';
import { DEFAULT_MODEL, DEFAULT_PROVIDER, PROMPT_COOKIE_KEY, PROVIDER_LIST } from '~/utils/constants';
import { cubicEasingFn } from '~/utils/easings';
import { createScopedLogger, renderLogger } from '~/utils/logger';
import { BaseChat } from './BaseChat';
import Cookies from 'js-cookie';
import { debounce } from '~/utils/debounce';
import { useSettings } from '~/lib/hooks/useSettings';
import type { ProviderInfo } from '~/types/model';
import { useSearchParams } from '@remix-run/react';
import { createSampler } from '~/utils/sampler';
import { getTemplates, selectStarterTemplate } from '~/utils/selectStarterTemplate';
import { logStore } from '~/lib/stores/logs';
import { streamingState } from '~/lib/stores/streaming';
import { filesToArtifacts } from '~/utils/fileUtils';
import { supabaseConnection } from '~/lib/stores/supabase';
import React, { useImperativeHandle, forwardRef } from 'react';

type ExternalSendMessageOptions = {
  model?: string;
  provider?: ProviderInfo;
  input?: string;
  imageDataList?: string[];
};

const toastAnimation = cssTransition({
  enter: 'animated fadeInRight',
  exit: 'animated fadeOutRight',
});

const logger = createScopedLogger('Chat');

export function Chat() {
  const chatRef = useRef<any>(null);
  renderLogger.trace('Chat');

  const { ready, initialMessages, storeMessageHistory, importChat, exportChat } = useChatHistory();
  const title = useStore(description);
  useEffect(() => {
    workbenchStore.setReloadedMessages(initialMessages.map((m) => m.id));
  }, [initialMessages]);

  // 轮询外部接口
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/external-send');

        if (res.ok) {
          const json = (await res.json()) as { data?: any };

          if (json && json.data) {
            chatRef.current?.externalSendMessage(json.data);
          }
        }
      } catch (e) {
        // 可加日志
      }
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  return (
    <>
      {ready && (
        <ChatImpl
          ref={chatRef}
          description={title}
          initialMessages={initialMessages}
          exportChat={exportChat}
          storeMessageHistory={storeMessageHistory}
          importChat={importChat}
        />
      )}
      <ToastContainer
        closeButton={({ closeToast }) => {
          return (
            <button className="Toastify__close-button" onClick={closeToast}>
              <div className="i-ph:x text-lg" />
            </button>
          );
        }}
        icon={({ type }) => {
          /**
           * @todo Handle more types if we need them. This may require extra color palettes.
           */
          switch (type) {
            case 'success': {
              return <div className="i-ph:check-bold text-bolt-elements-icon-success text-2xl" />;
            }
            case 'error': {
              return <div className="i-ph:warning-circle-bold text-bolt-elements-icon-error text-2xl" />;
            }
          }

          return undefined;
        }}
        position="bottom-right"
        pauseOnFocusLoss
        transition={toastAnimation}
        autoClose={3000}
      />
    </>
  );
}

const processSampledMessages = createSampler(
  (options: {
    messages: Message[];
    initialMessages: Message[];
    isLoading: boolean;
    parseMessages: (messages: Message[], isLoading: boolean) => void;
    storeMessageHistory: (messages: Message[]) => Promise<void>;
  }) => {
    const { messages, initialMessages, isLoading, parseMessages, storeMessageHistory } = options;
    parseMessages(messages, isLoading);

    if (messages.length > initialMessages.length) {
      storeMessageHistory(messages).catch((error) => toast.error(error.message));
    }
  },
  50,
);

interface ChatProps {
  initialMessages: Message[];
  storeMessageHistory: (messages: Message[]) => Promise<void>;
  importChat: (description: string, messages: Message[]) => Promise<void>;
  exportChat: () => void;
  description?: string;
}

export const ChatImpl = memo(
  forwardRef<any, ChatProps>((props, ref) => {
    useShortcuts();

    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [chatStarted, setChatStarted] = useState(props.initialMessages.length > 0);
    const [uploadedFiles, setUploadedFiles] = useState<File[]>([]);
    const [imageDataList, setImageDataList] = useState<string[]>([]);
    const [searchParams, setSearchParams] = useSearchParams();
    const [fakeLoading, setFakeLoading] = useState(false);
    const files = useStore(workbenchStore.files);
    const actionAlert = useStore(workbenchStore.alert);
    const deployAlert = useStore(workbenchStore.deployAlert);
    const supabaseConn = useStore(supabaseConnection); // Add this line to get Supabase connection
    const selectedProject = supabaseConn.stats?.projects?.find(
      (project) => project.id === supabaseConn.selectedProjectId,
    );
    const supabaseAlert = useStore(workbenchStore.supabaseAlert);
    const { activeProviders, promptId, autoSelectTemplate, contextOptimizationEnabled } = useSettings();

    const [model, setModel] = useState(() => {
      const savedModel = Cookies.get('selectedModel');
      return savedModel || DEFAULT_MODEL;
    });
    const [provider, setProvider] = useState(() => {
      const savedProvider = Cookies.get('selectedProvider');
      return (PROVIDER_LIST.find((p) => p.name === savedProvider) || DEFAULT_PROVIDER) as ProviderInfo;
    });

    const { showChat } = useStore(chatStore);

    const [animationScope, animate] = useAnimate();

    const [apiKeys, setApiKeys] = useState<Record<string, string>>({});

    const {
      messages,
      isLoading,
      input,
      handleInputChange,
      setInput,
      stop,
      append,
      setMessages,
      reload,
      error,
      data: chatData,
      setData,
    } = useChat({
      api: '/api/chat',
      body: {
        apiKeys,
        files,
        promptId,
        contextOptimization: contextOptimizationEnabled,
        supabase: {
          isConnected: supabaseConn.isConnected,
          hasSelectedProject: !!selectedProject,
          credentials: {
            supabaseUrl: supabaseConn?.credentials?.supabaseUrl,
            anonKey: supabaseConn?.credentials?.anonKey,
          },
        },
      },
      sendExtraMessageFields: true,
      onError: (e) => {
        logger.error('Request failed\n\n', e, error);
        logStore.logError('Chat request failed', e, {
          component: 'Chat',
          action: 'request',
          error: e.message,
        });
        toast.error(
          'There was an error processing your request: ' + (e.message ? e.message : 'No details were returned'),
        );
      },
      onFinish: async (message, response) => {
        const usage = response.usage;
        setData(undefined);

        if (usage) {
          console.log('Token usage:', usage);
          logStore.logProvider('Chat response completed', {
            component: 'Chat',
            action: 'response',
            model,
            provider: provider.name,
            usage,
            messageLength: message.content.length,
          });
        }

        logger.debug('Finished streaming');

        // 延迟6秒再进行下载
        await new Promise((resolve) => setTimeout(resolve, 6000));

        const downloadedFileName = await workbenchStore.downloadZip();
        logger.debug('Finished downloading zip');

        // 删除页面中的无用元素
        const removeTargetElements = () => {
          if (typeof window === 'undefined') {
            return;
          } // 确保只在浏览器中执行

          // 1. 删除 header 元素
          const header = document.querySelector(
            '#root > .bg-bolt-elements-background-depth-1 > header.flex.items-center.p-5.border-b',
          );

          if (header) {
            header.remove();
          }

          // 2. 删除 side-menu 侧边菜单
          const sideMenu = document.querySelector('#root ._BaseChat_15kx3_1 .side-menu');

          if (sideMenu) {
            sideMenu.remove();
          }

          // 3. 删除聊天内容主区域
          const chatMain = document.querySelector(
            '#root ._BaseChat_15kx3_1 .flex.flex-col.lg\\:flex-row ._Chat_15kx3_5',
          );

          if (chatMain) {
            chatMain.remove();
          }

          // 4. 删除workbench区域下的特定元素
          const workbenchElement = document.querySelector(
            '#root .z-workbench .fixed.top-\\[calc\\(var\\(--header-height\\)\\+1\\.5rem\\)\\] .absolute.inset-0 .h-full.flex.flex-col .flex.items-center.px-3.py-2.border-b',
          );

          if (workbenchElement) {
            workbenchElement.remove();
          }

          // 5. 删除workbench区域下与第四个元素同级的另一个元素
          const workbenchElement2 = document.querySelector(
            '#root .z-workbench .relative.flex-1.overflow-hidden .absolute.inset-0 .w-full.h-full.flex.flex-col .bg-bolt-elements-background-depth-2.p-2.flex.items-center.gap-2',
          );

          if (workbenchElement2) {
            workbenchElement2.remove();
          }
        };

        /*
         * 调用删除函数
         * removeTargetElements();
         */

        // 构建查询参数
        const queryParams = new URLSearchParams();

        if (downloadedFileName) {
          queryParams.append('fileName', downloadedFileName);
        }

        fetch(`/api/vali?${queryParams.toString()}`)
          .then((response) => {
            if (response.ok) {
              return response.json();
            }

            throw new Error(`HTTP error! status: ${response.status}`);
          })
          .then((data: any) => {
            console.log('Validation API response:', data);

            // 根据后端返回的message字段进行处理
            if (data.message === 'success') {
              // 显示成功弹窗
              toast.success('Successfully generated!');
            } else if (data.message === 'error') {
              // 显示错误弹窗，包含详细错误信息
              toast.error(`Error: ${data.result}`);
            } else {
              // 向外部接口发送POST请求
              fetch('http://localhost:5173/api/external-send', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  model: data.model,
                  provider: {
                    name: data.provider,
                  },
                  input: data.result,
                  imageDataList: [],
                }),
              })
                .then((response) => {
                  if (response.ok) {
                    console.log('External send request successful');
                  } else {
                    console.error('External send request failed:', response.status);
                  }
                })
                .catch((error) => {
                  console.error('Failed to send external request:', error);
                });
            }
          })
          .catch((error) => {
            console.log('Failed to call validation API:', error);
          });
      },
      initialMessages: props.initialMessages,
      initialInput: Cookies.get(PROMPT_COOKIE_KEY) || '',
    });
    useEffect(() => {
      const prompt = searchParams.get('prompt');

      // console.log(prompt, searchParams, model, provider);

      if (prompt) {
        setSearchParams({});
        runAnimation();
        append({
          role: 'user',
          content: [
            {
              type: 'text',
              text: `[Model: ${model}]\n\n[Provider: ${provider.name}]\n\n${prompt}`,
            },
          ] as any, // Type assertion to bypass compiler check
        });
      }
    }, [model, provider, searchParams]);

    const { enhancingPrompt, promptEnhanced, enhancePrompt, resetEnhancer } = usePromptEnhancer();
    const { parsedMessages, parseMessages } = useMessageParser();

    const TEXTAREA_MAX_HEIGHT = chatStarted ? 400 : 200;

    useEffect(() => {
      chatStore.setKey('started', props.initialMessages.length > 0);
    }, [props.initialMessages]);

    useEffect(() => {
      processSampledMessages({
        messages,
        initialMessages: props.initialMessages,
        isLoading,
        parseMessages,
        storeMessageHistory: props.storeMessageHistory,
      });
    }, [messages, isLoading, parseMessages, props.initialMessages, props.storeMessageHistory]);

    const scrollTextArea = () => {
      const textarea = textareaRef.current;

      if (textarea) {
        textarea.scrollTop = textarea.scrollHeight;
      }
    };

    const abort = () => {
      stop();
      chatStore.setKey('aborted', true);
      workbenchStore.abortAllActions();

      logStore.logProvider('Chat response aborted', {
        component: 'Chat',
        action: 'abort',
        model,
        provider: provider.name,
      });
    };

    useEffect(() => {
      const textarea = textareaRef.current;

      if (textarea) {
        textarea.style.height = 'auto';

        const scrollHeight = textarea.scrollHeight;

        textarea.style.height = `${Math.min(scrollHeight, TEXTAREA_MAX_HEIGHT)}px`;
        textarea.style.overflowY = scrollHeight > TEXTAREA_MAX_HEIGHT ? 'auto' : 'hidden';
      }
    }, [input, textareaRef]);

    const runAnimation = async () => {
      if (chatStarted) {
        return;
      }

      await Promise.all([
        animate('#examples', { opacity: 0, display: 'none' }, { duration: 0.1 }),
        animate('#intro', { opacity: 0, flex: 1 }, { duration: 0.2, ease: cubicEasingFn }),
      ]);

      chatStore.setKey('started', true);

      setChatStarted(true);
    };

    const sendMessage = async (
      _event: React.UIEvent,
      messageInput?: string,
      override?: { model?: string; provider?: ProviderInfo; imageDataList?: string[] },
    ) => {
      const messageContent = messageInput || input;

      // 优先用 override 里的值，否则用 state
      const usedModel = override?.model ?? model;
      const usedProvider = override?.provider ?? provider;
      const usedImageDataList = override?.imageDataList ?? imageDataList;

      if (!messageContent?.trim()) {
        return;
      }

      if (isLoading) {
        abort();
        return;
      }

      // If no locked items, proceed normally with the original message
      const finalMessageContent = messageContent;

      runAnimation();

      if (!chatStarted) {
        setFakeLoading(true);

        if (autoSelectTemplate) {
          const { template, title } = await selectStarterTemplate({
            message: finalMessageContent,
            model: usedModel,
            provider: usedProvider,
          });

          if (template !== 'blank') {
            const temResp = await getTemplates(template, title).catch((e) => {
              if (e.message.includes('rate limit')) {
                toast.warning('Rate limit exceeded. Skipping starter template\n Continuing with blank template');
              } else {
                toast.warning('Failed to import starter template\n Continuing with blank template');
              }

              return null;
            });

            if (temResp) {
              const { assistantMessage, userMessage } = temResp;
              setMessages([
                {
                  id: `1-${new Date().getTime()}`,
                  role: 'user',
                  content: [
                    {
                      type: 'text',
                      text: `[Model: ${usedModel}]\n\n[Provider: ${usedProvider.name}]\n\n${finalMessageContent}`,
                    },
                    ...(usedImageDataList || []).map((imageData) => ({
                      type: 'image',
                      image: imageData,
                    })),
                  ] as any,
                },
                {
                  id: `2-${new Date().getTime()}`,
                  role: 'assistant',
                  content: assistantMessage,
                },
                {
                  id: `3-${new Date().getTime()}`,
                  role: 'user',
                  content: `[Model: ${usedModel}]\n\n[Provider: ${usedProvider.name}]\n\n${userMessage}`,
                  annotations: ['hidden'],
                },
              ]);
              reload();
              setInput('');
              Cookies.remove(PROMPT_COOKIE_KEY);

              setUploadedFiles([]);
              setImageDataList([]);

              resetEnhancer();

              textareaRef.current?.blur();
              setFakeLoading(false);

              return;
            }
          }
        }

        // If autoSelectTemplate is disabled or template selection failed, proceed with normal message
        setMessages([
          {
            id: `${new Date().getTime()}`,
            role: 'user',
            content: [
              {
                type: 'text',
                text: `[Model: ${usedModel}]\n\n[Provider: ${usedProvider.name}]\n\n${finalMessageContent}`,
              },
              ...(usedImageDataList || []).map((imageData) => ({
                type: 'image',
                image: imageData,
              })),
            ] as any,
          },
        ]);
        reload();
        setFakeLoading(false);
        setInput('');
        Cookies.remove(PROMPT_COOKIE_KEY);

        setUploadedFiles([]);
        setImageDataList([]);

        resetEnhancer();

        textareaRef.current?.blur();

        return;
      }

      if (error != null) {
        setMessages(messages.slice(0, -1));
      }

      const modifiedFiles = workbenchStore.getModifiedFiles();

      chatStore.setKey('aborted', false);

      if (modifiedFiles !== undefined) {
        const userUpdateArtifact = filesToArtifacts(modifiedFiles, `${Date.now()}`);
        append({
          role: 'user',
          content: [
            {
              type: 'text',
              text: `[Model: ${usedModel}]\n\n[Provider: ${usedProvider.name}]\n\n${userUpdateArtifact}${finalMessageContent}`,
            },
            ...(usedImageDataList || []).map((imageData) => ({
              type: 'image',
              image: imageData,
            })),
          ] as any,
        });

        workbenchStore.resetAllFileModifications();
      } else {
        append({
          role: 'user',
          content: [
            {
              type: 'text',
              text: `[Model: ${usedModel}]\n\n[Provider: ${usedProvider.name}]\n\n${finalMessageContent}`,
            },
            ...(usedImageDataList || []).map((imageData) => ({
              type: 'image',
              image: imageData,
            })),
          ] as any,
        });
      }

      setInput('');
      Cookies.remove(PROMPT_COOKIE_KEY);

      setUploadedFiles([]);
      setImageDataList([]);

      resetEnhancer();

      textareaRef.current?.blur();
    };

    /**
     * Handles the change event for the textarea and updates the input state.
     * @param event - The change event from the textarea.
     */
    const onTextareaChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      handleInputChange(event);
    };

    /**
     * Debounced function to cache the prompt in cookies.
     * Caches the trimmed value of the textarea input after a delay to optimize performance.
     */
    const debouncedCachePrompt = useCallback(
      debounce((event: React.ChangeEvent<HTMLTextAreaElement>) => {
        const trimmedValue = event.target.value.trim();
        Cookies.set(PROMPT_COOKIE_KEY, trimmedValue, { expires: 30 });
      }, 1000),
      [],
    );

    useEffect(() => {
      const storedApiKeys = Cookies.get('apiKeys');

      if (storedApiKeys) {
        setApiKeys(JSON.parse(storedApiKeys));
      }
    }, []);

    const handleModelChange = (newModel: string) => {
      setModel(newModel);
      Cookies.set('selectedModel', newModel, { expires: 30 });
    };

    const handleProviderChange = (newProvider: ProviderInfo) => {
      setProvider(newProvider);
      Cookies.set('selectedProvider', newProvider.name, { expires: 30 });
    };

    // 暴露方法给外部
    useImperativeHandle(ref, () => ({
      /**
       * 允许外部控制 model、provider、input、imageDataList，并安全调用 sendMessage
       */
      externalSendMessage: (options: ExternalSendMessageOptions = {}) => {
        if (options.model) {
          setModel(options.model);
        }

        if (options.provider) {
          setProvider(options.provider);
        }

        if (options.input !== undefined) {
          setInput(options.input);
        }

        if (options.imageDataList) {
          setImageDataList(options.imageDataList);
        }

        // 延迟更久，确保 useState 已同步
        setTimeout(() => {
          sendMessage(null as any, options.input ?? input, {
            model: options.model,
            provider: options.provider,
            imageDataList: options.imageDataList,
          });
        }, 100);
      },
      focusInput: () => {
        textareaRef.current?.focus();
      },
    }));

    return (
      <BaseChat
        ref={animationScope}
        textareaRef={textareaRef}
        input={input}
        showChat={showChat}
        chatStarted={chatStarted}
        isStreaming={isLoading || fakeLoading}
        onStreamingChange={(streaming) => {
          streamingState.set(streaming);
        }}
        enhancingPrompt={enhancingPrompt}
        promptEnhanced={promptEnhanced}
        sendMessage={sendMessage}
        model={model}
        setModel={handleModelChange}
        provider={provider}
        setProvider={handleProviderChange}
        providerList={activeProviders}
        handleInputChange={(e) => {
          onTextareaChange(e);
          debouncedCachePrompt(e);
        }}
        handleStop={abort}
        description={props.description}
        importChat={props.importChat}
        exportChat={props.exportChat}
        messages={messages.map((message, i) => {
          if (message.role === 'user') {
            return message;
          }

          return {
            ...message,
            content: parsedMessages[i] || '',
          };
        })}
        enhancePrompt={() => {
          enhancePrompt(
            input,
            (input) => {
              setInput(input);
              scrollTextArea();
            },
            model,
            provider,
            apiKeys,
          );
        }}
        uploadedFiles={uploadedFiles}
        setUploadedFiles={setUploadedFiles}
        imageDataList={imageDataList}
        setImageDataList={setImageDataList}
        actionAlert={actionAlert}
        clearAlert={() => workbenchStore.clearAlert()}
        supabaseAlert={supabaseAlert}
        clearSupabaseAlert={() => workbenchStore.clearSupabaseAlert()}
        deployAlert={deployAlert}
        clearDeployAlert={() => workbenchStore.clearDeployAlert()}
        data={chatData}
      />
    );
  }),
);
