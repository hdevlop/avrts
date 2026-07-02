/*
 * Small simavr state dumper used by scripts/simavr-oracle.ts.
 *
 * It is built on demand against a local simavr install and is intentionally
 * boring C: load firmware, run until the requested cycle count, print JSON.
 */
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "simavr/avr_adc.h"
#include "simavr/avr_ioport.h"
#include "simavr/avr_twi.h"
#include "simavr/avr_uart.h"
#include "simavr/sim_avr.h"
#include "simavr/sim_elf.h"
#include "simavr/sim_hex.h"
#include "simavr/sim_io.h"
#include "simavr/sim_irq.h"

typedef struct dump_range_t {
  const char *label;
  uint32_t addr;
  uint32_t length;
} dump_range_t;

typedef struct poke_t {
  uint32_t addr;
  uint8_t value;
} poke_t;

typedef struct until_result_t {
  int enabled;
  uint32_t addr;
  uint32_t length;
  uint8_t start;
  uint8_t end;
} until_result_t;

typedef struct byte_buffer_t {
  uint8_t *data;
  uint32_t length;
  uint32_t capacity;
} byte_buffer_t;

typedef struct start_buffer_t {
  uint8_t *addresses;
  uint8_t *reads;
  uint32_t length;
  uint32_t capacity;
} start_buffer_t;

typedef struct twi_slave_t {
  avr_irq_t *irq;
  uint8_t address;
  uint8_t selected;
  start_buffer_t starts;
  byte_buffer_t writes;
  byte_buffer_t reads;
  uint32_t stops;
} twi_slave_t;

static void usage(const char *app) {
  fprintf(stderr,
          "Usage: %s --hex FILE [--mcu atmega328p] [--freq 16000000] "
          "[--cycles N] [--dump label:addr:length] [--poke addr:value] "
          "[--adc0-raw N] [--d2 high|low] "
          "[--until-result addr:length:start:end] [--flush-cycles N] "
          "[--twi-slave addr]\n",
          app);
  exit(2);
}

static uint32_t parse_u32(const char *value, const char *flag) {
  char *end = NULL;
  unsigned long parsed = strtoul(value, &end, 0);
  if (!value[0] || (end && *end)) {
    fprintf(stderr, "%s expects an integer, got %s\n", flag, value);
    exit(2);
  }
  return (uint32_t)parsed;
}

static uint64_t parse_u64(const char *value, const char *flag) {
  char *end = NULL;
  unsigned long long parsed = strtoull(value, &end, 0);
  if (!value[0] || (end && *end)) {
    fprintf(stderr, "%s expects an integer, got %s\n", flag, value);
    exit(2);
  }
  return (uint64_t)parsed;
}

static dump_range_t parse_dump(const char *value) {
  char *copy = strdup(value);
  if (!copy) {
    fprintf(stderr, "out of memory\n");
    exit(1);
  }
  char *label = copy;
  char *addr = strchr(copy, ':');
  char *length = addr ? strchr(addr + 1, ':') : NULL;
  if (!addr || !length) {
    fprintf(stderr, "--dump expects label:addr:length, got %s\n", value);
    exit(2);
  }
  *addr = '\0';
  *length = '\0';
  dump_range_t range = {
      .label = label,
      .addr = parse_u32(addr + 1, "--dump addr"),
      .length = parse_u32(length + 1, "--dump length"),
  };
  return range;
}

static poke_t parse_poke(const char *value) {
  char *copy = strdup(value);
  if (!copy) {
    fprintf(stderr, "out of memory\n");
    exit(1);
  }
  char *addr = copy;
  char *byte = strchr(copy, ':');
  if (!byte) {
    fprintf(stderr, "--poke expects addr:value, got %s\n", value);
    exit(2);
  }
  *byte = '\0';
  uint32_t parsed = parse_u32(byte + 1, "--poke value");
  if (parsed > 0xff) {
    fprintf(stderr, "--poke value expects a byte, got %s\n", byte + 1);
    exit(2);
  }
  poke_t poke = {
      .addr = parse_u32(addr, "--poke addr"),
      .value = (uint8_t)parsed,
  };
  free(copy);
  return poke;
}

static until_result_t parse_until_result(const char *value) {
  char *copy = strdup(value);
  if (!copy) {
    fprintf(stderr, "out of memory\n");
    exit(1);
  }
  char *addr = copy;
  char *length = strchr(copy, ':');
  char *start = length ? strchr(length + 1, ':') : NULL;
  char *end = start ? strchr(start + 1, ':') : NULL;
  if (!length || !start || !end) {
    fprintf(stderr, "--until-result expects addr:length:start:end, got %s\n", value);
    exit(2);
  }
  *length = '\0';
  *start = '\0';
  *end = '\0';
  uint32_t parsed_start = parse_u32(start + 1, "--until-result start");
  uint32_t parsed_end = parse_u32(end + 1, "--until-result end");
  if (parsed_start > 0xff || parsed_end > 0xff) {
    fprintf(stderr, "--until-result start/end expect bytes\n");
    exit(2);
  }
  until_result_t result = {
      .enabled = 1,
      .addr = parse_u32(addr, "--until-result addr"),
      .length = parse_u32(length + 1, "--until-result length"),
      .start = (uint8_t)parsed_start,
      .end = (uint8_t)parsed_end,
  };
  free(copy);
  return result;
}

static int parse_bool_pin(const char *value, const char *flag) {
  if (!strcmp(value, "high") || !strcmp(value, "true") || !strcmp(value, "1")) return 1;
  if (!strcmp(value, "low") || !strcmp(value, "false") || !strcmp(value, "0")) return 0;
  fprintf(stderr, "%s expects high/low, true/false, or 1/0, got %s\n", flag, value);
  exit(2);
}

static const char *state_name(int state) {
  switch (state) {
    case cpu_Limbo:
      return "limbo";
    case cpu_Stopped:
      return "stopped";
    case cpu_Running:
      return "running";
    case cpu_Sleeping:
      return "sleeping";
    case cpu_Step:
      return "step";
    case cpu_StepDone:
      return "step-done";
    case cpu_Done:
      return "done";
    case cpu_Crashed:
      return "crashed";
    default:
      return "unknown";
  }
}

static void print_byte_array(const uint8_t *data, uint32_t length) {
  printf("[");
  for (uint32_t i = 0; i < length; i++) {
    if (i) printf(",");
    printf("%u", data[i]);
  }
  printf("]");
}

static void append_byte(byte_buffer_t *buffer, uint8_t value) {
  if (buffer->length == buffer->capacity) {
    uint32_t next_capacity = buffer->capacity ? buffer->capacity * 2 : 64;
    uint8_t *next = (uint8_t *)realloc(buffer->data, next_capacity);
    if (!next) {
      fprintf(stderr, "out of memory\n");
      exit(1);
    }
    buffer->data = next;
    buffer->capacity = next_capacity;
  }
  buffer->data[buffer->length++] = value;
}

static void append_start(start_buffer_t *buffer, uint8_t address, uint8_t read) {
  if (buffer->length == buffer->capacity) {
    uint32_t next_capacity = buffer->capacity ? buffer->capacity * 2 : 16;
    uint8_t *next_addresses = (uint8_t *)realloc(buffer->addresses, next_capacity);
    uint8_t *next_reads = (uint8_t *)realloc(buffer->reads, next_capacity);
    if (!next_addresses || !next_reads) {
      fprintf(stderr, "out of memory\n");
      exit(1);
    }
    buffer->addresses = next_addresses;
    buffer->reads = next_reads;
    buffer->capacity = next_capacity;
  }
  buffer->addresses[buffer->length] = address;
  buffer->reads[buffer->length] = read;
  buffer->length++;
}

static uint8_t next_twi_read(twi_slave_t *slave) {
  uint8_t last = slave->writes.length ? slave->writes.data[slave->writes.length - 1] : 0;
  uint8_t prev = slave->writes.length > 1 ? slave->writes.data[slave->writes.length - 2] : 0;
  return (uint8_t)(0xa5 ^ last ^ prev ^ ((slave->writes.length * 17) & 0xff));
}

static void uart_output_hook(struct avr_irq_t *irq, uint32_t value, void *param) {
  (void)irq;
  append_byte((byte_buffer_t *)param, (uint8_t)(value & 0xff));
}

static void twi_slave_hook(struct avr_irq_t *irq, uint32_t value, void *param) {
  (void)irq;
  twi_slave_t *slave = (twi_slave_t *)param;
  avr_twi_msg_irq_t message;
  message.u.v = value;

  if (message.u.twi.msg & TWI_COND_STOP) {
    if (slave->selected) slave->stops++;
    slave->selected = 0;
    return;
  }

  if (message.u.twi.msg & TWI_COND_START) {
    slave->selected = 0;
    if ((message.u.twi.addr >> 1) == slave->address) {
      slave->selected = message.u.twi.addr;
      append_start(&slave->starts, slave->address, (message.u.twi.addr & 1) ? 1 : 0);
      avr_raise_irq(slave->irq + TWI_IRQ_INPUT, avr_twi_irq_msg(TWI_COND_ACK, slave->selected, 1));
    }
    return;
  }

  if (!slave->selected) return;

  if (message.u.twi.msg & TWI_COND_WRITE) {
    append_byte(&slave->writes, message.u.twi.data);
    avr_raise_irq(slave->irq + TWI_IRQ_INPUT, avr_twi_irq_msg(TWI_COND_ACK, slave->selected, 1));
  }

  if (message.u.twi.msg & TWI_COND_READ) {
    uint8_t value_to_send = next_twi_read(slave);
    append_byte(&slave->reads, value_to_send);
    avr_raise_irq(slave->irq + TWI_IRQ_INPUT, avr_twi_irq_msg(TWI_COND_READ, slave->selected, value_to_send));
  }
}

static const char *twi_irq_names[TWI_IRQ_COUNT] = {
    [TWI_IRQ_INPUT] = "8>oracle-twi.out",
    [TWI_IRQ_OUTPUT] = "32<oracle-twi.in",
    [TWI_IRQ_STATUS] = "oracle-twi.status",
};

static void attach_twi_slave(avr_t *avr, twi_slave_t *slave, uint8_t address) {
  memset(slave, 0, sizeof(*slave));
  slave->address = address;
  slave->irq = avr_alloc_irq(&avr->irq_pool, 0, TWI_IRQ_COUNT, twi_irq_names);
  avr_irq_register_notify(slave->irq + TWI_IRQ_OUTPUT, twi_slave_hook, slave);
  avr_connect_irq(slave->irq + TWI_IRQ_INPUT, avr_io_getirq(avr, AVR_IOCTL_TWI_GETIRQ(0), TWI_IRQ_INPUT));
  avr_connect_irq(avr_io_getirq(avr, AVR_IOCTL_TWI_GETIRQ(0), TWI_IRQ_OUTPUT), slave->irq + TWI_IRQ_OUTPUT);
}

static int result_complete(avr_t *avr, const until_result_t *until) {
  if (!until->enabled || until->length == 0) return 0;
  uint32_t ram_size = (uint32_t)avr->ramend + 1;
  if (until->addr >= ram_size || until->addr + until->length > ram_size) return 0;
  return avr->data[until->addr] == until->start && avr->data[until->addr + until->length - 1] == until->end;
}

int main(int argc, char **argv) {
  const char *hex = NULL;
  const char *mcu = "atmega328p";
  uint32_t frequency = 16000000;
  uint64_t target_cycles = 1000;
  uint64_t flush_cycles = 0;
  dump_range_t dumps[32];
  int dump_count = 0;
  poke_t pokes[32];
  int poke_count = 0;
  int adc0_raw = -1;
  int d2 = -1;
  int twi_slave_enabled = 0;
  uint8_t twi_slave_address = 0;
  until_result_t until_result;
  memset(&until_result, 0, sizeof(until_result));

  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--hex") && i + 1 < argc) {
      hex = argv[++i];
    } else if (!strcmp(argv[i], "--mcu") && i + 1 < argc) {
      mcu = argv[++i];
    } else if (!strcmp(argv[i], "--freq") && i + 1 < argc) {
      frequency = parse_u32(argv[++i], "--freq");
    } else if (!strcmp(argv[i], "--cycles") && i + 1 < argc) {
      target_cycles = parse_u64(argv[++i], "--cycles");
    } else if (!strcmp(argv[i], "--dump") && i + 1 < argc) {
      if (dump_count >= (int)(sizeof(dumps) / sizeof(dumps[0]))) {
        fprintf(stderr, "too many --dump ranges\n");
        return 2;
      }
      dumps[dump_count++] = parse_dump(argv[++i]);
    } else if (!strcmp(argv[i], "--poke") && i + 1 < argc) {
      if (poke_count >= (int)(sizeof(pokes) / sizeof(pokes[0]))) {
        fprintf(stderr, "too many --poke values\n");
        return 2;
      }
      pokes[poke_count++] = parse_poke(argv[++i]);
    } else if (!strcmp(argv[i], "--adc0-raw") && i + 1 < argc) {
      uint32_t parsed = parse_u32(argv[++i], "--adc0-raw");
      if (parsed > 1023) {
        fprintf(stderr, "--adc0-raw expects 0..1023\n");
        return 2;
      }
      adc0_raw = (int)parsed;
    } else if (!strcmp(argv[i], "--d2") && i + 1 < argc) {
      d2 = parse_bool_pin(argv[++i], "--d2");
    } else if (!strcmp(argv[i], "--until-result") && i + 1 < argc) {
      until_result = parse_until_result(argv[++i]);
    } else if (!strcmp(argv[i], "--flush-cycles") && i + 1 < argc) {
      flush_cycles = parse_u64(argv[++i], "--flush-cycles");
    } else if (!strcmp(argv[i], "--twi-slave") && i + 1 < argc) {
      uint32_t parsed = parse_u32(argv[++i], "--twi-slave");
      if (parsed > 0x7f) {
        fprintf(stderr, "--twi-slave expects a 7-bit address\n");
        return 2;
      }
      twi_slave_enabled = 1;
      twi_slave_address = (uint8_t)parsed;
    } else {
      usage(argv[0]);
    }
  }
  if (!hex) usage(argv[0]);

  elf_firmware_t firmware;
  memset(&firmware, 0, sizeof(firmware));
  snprintf(firmware.mmcu, sizeof(firmware.mmcu), "%s", mcu);
  firmware.frequency = frequency;
  sim_setup_firmware(hex, AVR_SEGMENT_OFFSET_FLASH, &firmware, argv[0]);
  snprintf(firmware.mmcu, sizeof(firmware.mmcu), "%s", mcu);
  firmware.frequency = frequency;

  avr_t *avr = avr_make_mcu_by_name(firmware.mmcu);
  if (!avr) {
    fprintf(stderr, "unknown AVR core %s\n", firmware.mmcu);
    return 1;
  }
  avr_init(avr);
  avr->log = LOG_NONE;
  avr_load_firmware(avr, &firmware);

  for (int i = 0; i < poke_count; i++) {
    uint32_t ram_size = (uint32_t)avr->ramend + 1;
    if (pokes[i].addr < ram_size) avr->data[pokes[i].addr] = pokes[i].value;
  }

  if (adc0_raw >= 0) {
    avr->vcc = 5000;
    avr->avcc = 5000;
    avr->aref = 5000;
    uint32_t millivolts = ((uint32_t)adc0_raw * 5000u + 1022u) / 1023u;
    avr_raise_irq(avr_io_getirq(avr, AVR_IOCTL_ADC_GETIRQ, ADC_IRQ_ADC0), millivolts);
  }

  if (d2 >= 0) {
    avr_ioport_external_t external = {
        .name = 'D',
        .mask = (1 << 2),
        .value = d2 ? (1 << 2) : 0,
    };
    avr_ioctl(avr, AVR_IOCTL_IOPORT_SET_EXTERNAL('D'), &external);
    avr_raise_irq(avr_io_getirq(avr, AVR_IOCTL_IOPORT_GETIRQ('D'), IOPORT_IRQ_PIN2), d2 ? 1 : 0);
  }

  byte_buffer_t serial;
  memset(&serial, 0, sizeof(serial));
  avr_irq_register_notify(avr_io_getirq(avr, AVR_IOCTL_UART_GETIRQ('0'), UART_IRQ_OUTPUT), uart_output_hook, &serial);

  twi_slave_t twi_slave;
  memset(&twi_slave, 0, sizeof(twi_slave));
  if (twi_slave_enabled) attach_twi_slave(avr, &twi_slave, twi_slave_address);

  int state = avr->state;
  while ((uint64_t)avr->cycle < target_cycles) {
    state = avr_run(avr);
    if (state == cpu_Done || state == cpu_Crashed) break;
    if (until_result.enabled && result_complete(avr, &until_result)) break;
  }
  int completed = until_result.enabled ? result_complete(avr, &until_result) : 0;
  if (completed && flush_cycles > 0) {
    uint64_t flush_target = (uint64_t)avr->cycle + flush_cycles;
    while ((uint64_t)avr->cycle < flush_target) {
      state = avr_run(avr);
      if (state == cpu_Done || state == cpu_Crashed) break;
    }
  }

  uint16_t sp = (uint16_t)(avr->data[R_SPL] | (avr->data[R_SPH] << 8));
  printf("{");
  printf("\"mcu\":\"%s\",", firmware.mmcu);
  printf("\"frequency\":%" PRIu32 ",", firmware.frequency);
  printf("\"targetCycles\":%" PRIu64 ",", target_cycles);
  printf("\"cycles\":%" PRIu64 ",", (uint64_t)avr->cycle);
  printf("\"completed\":%s,", completed ? "true" : "false");
  printf("\"state\":\"%s\",", state_name(state));
  printf("\"pcBytes\":%" PRIu32 ",", (uint32_t)avr->pc);
  printf("\"pcWords\":%" PRIu32 ",", (uint32_t)(avr->pc >> 1));
  printf("\"sp\":%u,", sp);
  printf("\"sreg\":%u,", avr->data[R_SREG]);
  printf("\"registers\":");
  print_byte_array(avr->data, 32);
  printf(",\"dumps\":{");
  for (int i = 0; i < dump_count; i++) {
    if (i) printf(",");
    uint32_t addr = dumps[i].addr;
    uint32_t length = dumps[i].length;
    uint32_t ram_size = (uint32_t)avr->ramend + 1;
    if (addr > ram_size) length = 0;
    if (addr + length > ram_size) length = ram_size - addr;
    printf("\"%s\":", dumps[i].label);
    print_byte_array(avr->data + addr, length);
  }
  printf("},\"serial\":");
  print_byte_array(serial.data, serial.length);
  printf(",\"twi\":{\"starts\":[");
  for (uint32_t i = 0; i < twi_slave.starts.length; i++) {
    if (i) printf(",");
    printf("\"%c@%02x\"", twi_slave.starts.reads[i] ? 'R' : 'W', twi_slave.starts.addresses[i]);
  }
  printf("],\"writes\":");
  print_byte_array(twi_slave.writes.data, twi_slave.writes.length);
  printf(",\"reads\":");
  print_byte_array(twi_slave.reads.data, twi_slave.reads.length);
  printf(",\"stops\":%" PRIu32 "}}", twi_slave.stops);
  printf("\n");

  avr_terminate(avr);
  free(serial.data);
  free(twi_slave.starts.addresses);
  free(twi_slave.starts.reads);
  free(twi_slave.writes.data);
  free(twi_slave.reads.data);
  return state == cpu_Crashed ? 1 : 0;
}
