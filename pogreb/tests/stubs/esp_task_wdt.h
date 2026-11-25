#pragma once
#include <stdint.h>
typedef int esp_err_t;
#define ESP_OK 0
typedef struct { uint32_t timeout_ms; uint32_t idle_core_mask; bool trigger_panic; } esp_task_wdt_config_t;
#if ESP_ARDUINO_VERSION_MAJOR >= 3
esp_err_t esp_task_wdt_init(const esp_task_wdt_config_t*);
esp_err_t esp_task_wdt_reconfigure(const esp_task_wdt_config_t*);
#else
esp_err_t esp_task_wdt_init(uint32_t timeout_s, bool panic);
#endif
esp_err_t esp_task_wdt_add(void* task);
esp_err_t esp_task_wdt_reset(void);
